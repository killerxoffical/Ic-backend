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

// --- Global Settings ---
const MAX_CANDLES = 500;        // RAM এ সর্বোচ্চ কতগুলো ক্যান্ডেল থাকবে
const TIMEFRAME = 60000;        // ১ মিনিটের ক্যান্ডেল
const TICK_MS = 250;            // প্রতি ২৫০ms পর পর প্রাইস আপডেট
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300; // সার্ভার চালু হলে ৩০০টি ক্যান্ডেল বানিয়ে নিবে

const markets = {}; 
let pendingCommands = {};       // অ্যাডমিন কমান্ড এখানে অপেক্ষা করবে

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- ফায়ারবেস থেকে রিয়েলটাইমে কমান্ড রিসিভ করা ---
db.ref('admin/pending_patterns').on('value', (snapshot) => {
    pendingCommands = snapshot.val() || {};
});

// --- 🔥 কোর ফাংশন ১: টার্গেট OHLC জেনারেটর (What to draw) ---
function generateTargetOHLC(openPrice, pattern) {
    const vol = openPrice * 0.00015; // মার্কেটের সাধারণ ভলাটিলিটি
    let O = openPrice, C, H, L;
    let actualPattern = pattern || 'NORMAL';
    
    switch(actualPattern) {
        case 'MARUBOZU_GREEN':
            C = O + (vol * 4); H = C; L = O; break;
        case 'MARUBOZU_RED':
            C = O - (vol * 4); H = O; L = C; break;
            
        case 'HAMMER_GREEN':
            C = O + (vol * 1); H = C + (vol * 0.2); L = O - (vol * 5); break;
        case 'HAMMER_RED':
            C = O - (vol * 1); H = O + (vol * 0.2); L = C - (vol * 5); break;
            
        case 'SHOOTING_STAR_GREEN':
            C = O + (vol * 1); H = C + (vol * 5); L = O - (vol * 0.2); break;
        case 'SHOOTING_STAR_RED':
            C = O - (vol * 1); H = O + (vol * 5); L = C - (vol * 0.2); break;
            
        case 'DOJI':
            let isDojiUp = Math.random() > 0.5;
            C = O + (isDojiUp ? 1 : -1) * (vol * 0.1); H = O + (vol * 3); L = O - (vol * 3); break;
            
        default: // NORMAL (Random)
            let isUp = Math.random() > 0.5;
            let body = vol * (0.5 + Math.random() * 2);
            C = isUp ? O + body : O - body;
            H = Math.max(O, C) + (vol * Math.random() * 1.5);
            L = Math.min(O, C) - (vol * Math.random() * 1.5);
            actualPattern = 'NORMAL';
    }
    return { open: roundPrice(O), high: roundPrice(H), low: roundPrice(L), close: roundPrice(C), pattern: actualPattern };
}

// --- 🔥 কোর ফাংশন ২: রিয়েলিস্টিক অ্যানিমেশন রুট (How to draw) ---
function calculateCurrentPrice(marketData, progress) {
    const target = marketData.target;
    if (!target) return marketData.currentPrice;

    const { open: O, high: H, low: L, close: C, pattern } = target;
    let basePrice;

    if (pattern.includes('HAMMER')) {
        if (progress < 0.5) basePrice = O + (L - O) * (progress / 0.5); // দ্রুত নিচে নামবে
        else basePrice = L + (C - L) * ((progress - 0.5) / 0.5); // ধীরে উপরে উঠবে
    } 
    else if (pattern.includes('SHOOTING_STAR')) {
        if (progress < 0.5) basePrice = O + (H - O) * (progress / 0.5); // দ্রুত উপরে উঠবে
        else basePrice = H + (C - H) * ((progress - 0.5) / 0.5); // ধীরে নিচে নামবে
    }
    else if (pattern.includes('DOJI')) {
        if (progress < 0.33) basePrice = O + (H - O) * (progress / 0.33); // High এ যাবে
        else if (progress < 0.66) basePrice = H + (L - H) * ((progress - 0.33) / 0.33); // Low তে যাবে
        else basePrice = L + (C - L) * ((progress - 0.66) / 0.34); // Close এর দিকে যাবে
    }
    else { // NORMAL or MARUBOZU
        basePrice = O + (C - O) * progress;
    }

    const noiseAllowed = Math.abs(H - L) * 0.1 * (1 - progress);
    marketData.currentPrice = basePrice + ((Math.random() - 0.5) * noiseAllowed);

    if (progress >= 0.98) marketData.currentPrice = C; // শেষ মুহূর্তে টার্গেটে ফিক্সড

    return roundPrice(Math.max(L, Math.min(H, marketData.currentPrice)));
}

// --- সার্ভার চালু হলে মার্কেট ইনিশিয়ালাইজ করা ---
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try { const liveSnap = await db.ref(`markets/${path}/live`).once('value'); if (liveSnap.val()?.price) startPrice = liveSnap.val().price; } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const p = generateTargetOHLC(currentPrice, 'NORMAL');
        candles.push({ timestamp: nowPeriod - (i * TIMEFRAME), ...p });
        currentPrice = p.close;
    }
    markets[marketId] = { marketId, marketPath: path, history: candles, target: null, currentPrice: startPrice };
    console.log(`Initialized market: ${marketId}`);
}

// --- প্রতি মিনিটের শুরুতে নতুন টার্গেট সেট করা ---
function ensureNewCandleTarget(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];

    if (!marketData.target || marketData.target.timestamp !== currentPeriod) {
        let openPrice = lastCandle ? lastCandle.close : 1.15;
        let selectedPattern = 'NORMAL';

        if (pendingCommands[marketData.marketId]) {
            selectedPattern = pendingCommands[marketData.marketId];
            console.log(`[ADMIN] Executing ${selectedPattern} for ${marketData.marketId}`);
            db.ref(`admin/pending_patterns/${marketData.marketId}`).remove();
        }

        marketData.target = { timestamp: currentPeriod, ...generateTargetOHLC(openPrice, selectedPattern) };
        marketData.currentPrice = openPrice; // অ্যানিমেশনের শুরুতে প্রাইস ওপেন থেকে শুরু হবে
        
        marketData.history.push({ timestamp: currentPeriod, open: openPrice, high: openPrice, low: openPrice, close: openPrice });
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    }
}

// --- প্রতিটি টিকে প্রাইস আপডেট এবং ব্রডকাস্ট ---
function processMarketTick(marketData, currentPeriod) {
    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0); 
    
    const newPrice = calculateCurrentPrice(marketData, progress);

    liveCandle.close = newPrice;
    liveCandle.high = roundPrice(Math.max(liveCandle.high, newPrice));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, newPrice));

    broadcastCandle(marketData.marketId, liveCandle);
}

function broadcastCandle(marketId, candle) {
    // 🔥 ফ্রন্টএন্ডকে প্যাটার্নের নাম পাঠিয়ে দেওয়া হচ্ছে 🔥
    const payloadData = { market: marketId, candle: { ...candle, pattern: markets[marketId].target.pattern }, serverTime: Date.now() };
    const payload = JSON.stringify(payloadData);
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.subscribedMarket === marketId) c.send(payload); });
}

// --- সার্বিক কার্যক্রম ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => { if ((fbMarkets[marketId]?.type === 'otc' || fbMarkets[marketId]?.type === 'broker_real') && !markets[marketId]) initializeNewMarket(marketId); });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                if (markets[msg.market]) ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-HISTORY_SEED_COUNT) }));
            }
        } catch (_) {}
    });
});

app.get('/api/history/:marketId', (req, res) => {
    if (markets[req.params.marketId]) {
        res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=60');
        res.json(markets[req.params.marketId].history.slice(-HISTORY_SEED_COUNT));
    } else res.status(404).json({ error: 'Market not found' });
});

// --- Main Loop ---
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (const marketId in markets) {
        ensureNewCandleTarget(markets[marketId], currentPeriod); // নতুন ক্যান্ডেলের টার্গেট সেট
        processMarketTick(markets[marketId], currentPeriod); // প্রাইস মুভমেন্ট
    }
}, TICK_MS);

// --- Firebase Live Price Sync ---
setInterval(() => {
    const batchUpdates = {};
    for (const marketId in markets) {
        const m = markets[marketId];
        const lastC = m.history[m.history.length-1];
        if (lastC) batchUpdates[`markets/${m.marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
    }
    db.ref().update(batchUpdates).catch(()=>{});
}, 30000); // প্রতি ৩০ সেকেন্ড পর পর আপডেট

app.get('/ping', (_req, res) => res.send('Pattern Engine V2 Active'));
server.listen(process.env.PORT || 3000, () => console.log(`Server started on port ${process.env.PORT || 3000}`));