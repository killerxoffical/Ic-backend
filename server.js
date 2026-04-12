const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- Firebase Configuration ---
const firebaseConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade",
    storageBucket: "ictex-trade.appspot.com",
    messagingSenderId: "755532704199",
    appId: "1:755532704199:web:b27d7c9e7d0f4ac76291e2"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 500;
const TIMEFRAME = 60000;
const TICK_MS = 250;

const markets = {}; 
let cloneCommands = {};

function roundPrice(v) { return parseFloat(v.toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- অ্যাডমিনের ক্লোন কমান্ড রিসিভ করা ---
db.ref('admin/clone_candle_command').on('value', (snapshot) => {
    cloneCommands = snapshot.val() || {};
});

// --- নরমাল রেন্ডম ক্যান্ডেল জেনারেটর ---
function generateNormalOHLC(openPrice) {
    const vol = openPrice * 0.00015;
    const isUp = Math.random() > 0.5;
    const body = vol * (0.5 + Math.random() * 2);
    const C = isUp ? openPrice + body : openPrice - body;
    const H = Math.max(openPrice, C) + (vol * Math.random() * 1.5);
    const L = Math.min(openPrice, C) - (vol * Math.random() * 1.5);
    return { open: roundPrice(openPrice), high: roundPrice(H), low: roundPrice(L), close: roundPrice(C), pattern: 'NORMAL' };
}

// --- অ্যানিমেশন পাথ ক্যালকুলেটর ---
function calculateCurrentPrice(marketData, progress) {
    const target = marketData.target;
    if (!target) return marketData.currentPrice;

    const { open: O, high: H, low: L, close: C } = target;
    let basePrice;

    // Waypoint Logic: Low -> High -> Close
    if (progress < 0.4) basePrice = O + (L - O) * (progress / 0.4);
    else if (progress < 0.7) basePrice = L + (H - L) * ((progress - 0.4) / 0.3);
    else basePrice = H + (C - H) * ((progress - 0.7) / 0.3);

    const noise = (Math.random() - 0.5) * (Math.abs(H - L) * 0.1);
    marketData.currentPrice = basePrice + noise;

    if (progress >= 0.98) marketData.currentPrice = C;

    return roundPrice(Math.max(L, Math.min(H, marketData.currentPrice)));
}

// --- মার্কেট ইনিশিয়ালাইজেশন ---
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try { const snap = await db.ref(`markets/${path}/live`).once('value'); if (snap.val()?.price) startPrice = snap.val().price; } catch (e) {}

    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let price = startPrice;

    for (let i = 300; i > 0; i--) {
        const p = generateNormalOHLC(price);
        candles.push({ timestamp: now - (i * TIMEFRAME), ...p });
        price = p.close;
    }
    markets[marketId] = { marketId, marketPath: path, history: candles, target: null, currentPrice: price };
    console.log(`Market Initialized: ${marketId}`);
}

// --- প্রতি মিনিটে নতুন ক্যান্ডেলের টার্গেট সেট করা ---
function ensureNewCandleTarget(marketData, currentPeriod) {
    const last = marketData.history[marketData.history.length - 1];
    
    if (!marketData.target || marketData.target.timestamp !== currentPeriod) {
        const openPrice = last ? last.close : 1.15;
        let targetOHLC;

        const cmd = cloneCommands[marketData.marketId];
        if (cmd && cmd.timestamp) {
            const candleToClone = marketData.history.find(c => c.timestamp === cmd.timestamp);
            if (candleToClone) {
                const body = Math.abs(candleToClone.close - candleToClone.open);
                const upWick = candleToClone.high - Math.max(candleToClone.open, candleToClone.close);
                const lowWick = Math.min(candleToClone.open, candleToClone.close) - candleToClone.low;
                const isGreen = candleToClone.close >= candleToClone.open;

                const newClose = isGreen ? openPrice + body : openPrice - body;
                const newHigh = Math.max(openPrice, newClose) + upWick;
                const newLow = Math.min(openPrice, newClose) - lowWick;

                targetOHLC = { open: openPrice, high: newHigh, low: newLow, close: newClose, pattern: 'CLONED' };
                console.log(`[ADMIN] Cloning candle for ${marketData.marketId}`);
            }
            db.ref(`admin/clone_candle_command/${marketData.marketId}`).remove();
        }

        if (!targetOHLC) {
            targetOHLC = generateNormalOHLC(openPrice);
        }

        marketData.target = { timestamp: currentPeriod, ...targetOHLC };
        marketData.currentPrice = openPrice;
        
        marketData.history.push({ timestamp: currentPeriod, ...targetOHLC, high: openPrice, low: openPrice, close: openPrice });
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    }
}

// --- কোর লুপ এবং ব্রডকাস্টিং ---
function processMarketTick(marketData, currentPeriod) {
    const liveCandle = marketData.history[marketData.history.length - 1];
    const progress = Math.min((Date.now() - currentPeriod) / TIMEFRAME, 1.0);
    const newPrice = calculateCurrentPrice(marketData, progress);

    liveCandle.close = newPrice;
    liveCandle.high = roundPrice(Math.max(liveCandle.high, newPrice));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, newPrice));

    broadcastCandle(marketData.marketId, liveCandle);
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.subscribedMarket === marketId) c.send(payload); });
}

// --- সব সেটআপ এবং সার্ভার স্টার্ট ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(id => { if (fbMarkets[id]?.type === 'otc' && !markets[id]) initializeNewMarket(id); });
});

wss.on('connection', ws => {
    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'subscribe' && markets[msg.market]) {
                ws.subscribedMarket = msg.market;
                ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history }));
            }
        } catch (_) {}
    });
});

app.get('/api/history/:marketId', (req, res) => {
    if (markets[req.params.marketId]) {
        res.setHeader('Cache-Control', 'public, s-maxage=60');
        res.json(markets[req.params.marketId].history);
    } else res.status(404).json({ error: 'Market not found' });
});

setInterval(() => {
    const now = Date.now();
    const period = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    for (const id in markets) {
        ensureNewCandleTarget(markets[id], period);
        processMarketTick(markets[id], period);
    }
}, TICK_MS);

setInterval(() => {
    const updates = {};
    for (const id in markets) {
        const last = markets[id].history[markets[id].history.length - 1];
        if (last) updates[`markets/${markets[id].marketPath}/live`] = { price: last.close, timestamp: last.timestamp };
    }
    db.ref().update(updates).catch(() => {});
}, 30000);

app.get('/ping', (_, res) => res.send('Clone Engine Active'));
server.listen(process.env.PORT || 3000, () => console.log('Server started'));