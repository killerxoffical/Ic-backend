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
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
let activeAdminCommands = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Listen to Admin Pattern Commands ---
db.ref('admin/market_control').on('value', (snapshot) => {
    activeAdminCommands = snapshot.val() || {};
});

// --- 🎯 PATTERN MATH GENERATOR 🎯 ---
function generatePatternCandle(openPrice, patternType) {
    const baseVol = openPrice * 0.00015; // মার্কেটের নরমাল ভলিউম
    let c, h, l;
    let color = 'GREEN';

    switch(patternType) {
        case 'MARUBOZU_GREEN':
            c = openPrice + (baseVol * 3); h = c; l = openPrice; color = 'GREEN'; break;
        case 'MARUBOZU_RED':
            c = openPrice - (baseVol * 3); h = openPrice; l = c; color = 'RED'; break;
        case 'HAMMER_GREEN':
            c = openPrice + (baseVol * 0.5); h = c + (baseVol * 0.1); l = openPrice - (baseVol * 2.5); color = 'GREEN'; break;
        case 'HAMMER_RED':
            c = openPrice - (baseVol * 0.5); h = openPrice + (baseVol * 0.1); l = c - (baseVol * 2.5); color = 'RED'; break;
        case 'SHOOTING_STAR_GREEN':
            c = openPrice + (baseVol * 0.5); h = c + (baseVol * 2.5); l = openPrice - (baseVol * 0.1); color = 'GREEN'; break;
        case 'SHOOTING_STAR_RED':
            c = openPrice - (baseVol * 0.5); h = openPrice + (baseVol * 2.5); l = c - (baseVol * 0.1); color = 'RED'; break;
        case 'DOJI':
            let isUp = Math.random() > 0.5;
            c = openPrice + (isUp ? 1 : -1) * (baseVol * 0.05); 
            h = openPrice + (baseVol * 2); 
            l = openPrice - (baseVol * 2); 
            color = isUp ? 'GREEN' : 'RED';
            break;
        default: // NORMAL RANDOM
            let rIsUp = Math.random() > 0.5;
            let body = baseVol * (0.5 + Math.random());
            c = rIsUp ? openPrice + body : openPrice - body;
            h = Math.max(openPrice, c) + (baseVol * Math.random());
            l = Math.min(openPrice, c) - (baseVol * Math.random());
            color = rIsUp ? 'GREEN' : 'RED';
    }

    return { open: roundPrice(openPrice), close: roundPrice(c), high: roundPrice(h), low: roundPrice(l), color, pattern: patternType };
}

// --- Initialize Market ---
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try { const liveSnap = await db.ref(`markets/${path}/live`).once('value'); if (liveSnap.val()?.price) startPrice = liveSnap.val().price; } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const pData = generatePatternCandle(currentPrice, 'NORMAL');
        candles.push({ timestamp: nowPeriod - (i * TIMEFRAME), open: pData.open, high: pData.high, low: pData.low, close: pData.close });
        currentPrice = pData.close;
    }
    markets[marketId] = { marketId, marketPath: path, history: candles, targetCandle: null, currentPrice: startPrice };
}

// --- Set Target at 00 Seconds ---
function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        let openPrice = lastCandle ? lastCandle.close : 1.15;
        let targetData;

        // চেক করুন ডাটাবেজে Pending কমান্ড আছে কি না
        const cmd = activeAdminCommands[marketData.marketId];
        if (cmd && cmd.status === 'pending') {
            // কমান্ড অনুযায়ী প্যাটার্ন জেনারেট করুন
            targetData = generatePatternCandle(openPrice, cmd.pattern);
            
            // কমান্ডটিকে Pending থেকে Executing এ আপডেট করুন, যাতে এটি শুধু একবারই কাজ করে
            db.ref(`admin/market_control/${marketData.marketId}`).update({ status: 'executing', executedAt: currentPeriod });
            console.log(`[ADMIN] ${marketData.marketId} Drawing Pattern: ${cmd.pattern}`);
        } else {
            // কমান্ড না থাকলে নরমাল রেন্ডম ক্যান্ডেল
            targetData = generatePatternCandle(openPrice, 'NORMAL');
        }

        marketData.targetCandle = { timestamp: currentPeriod, ...targetData };
        marketData.currentPrice = openPrice;
        
        marketData.history.push({ timestamp: currentPeriod, open: targetData.open, high: targetData.open, low: targetData.open, close: targetData.open });
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    }
}

// --- Draw the Pattern Smoothly ---
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    // প্যাটার্ন রিয়েলিস্টিক করার জন্য Waypoints (প্রাইস কোন দিকে আগে যাবে)
    let targetWaypoint;
    if (progress < 0.4) {
        // প্রথম ২৪ সেকেন্ডে শ্যাডো (Wick) তৈরি করবে
        targetWaypoint = (target.close > target.open) ? target.low : target.high;
    } else if (progress < 0.7) {
        // পরের ১৮ সেকেন্ডে বিপরীত শ্যাডো তৈরি করবে
        targetWaypoint = (target.close > target.open) ? target.high : target.low;
    } else {
        // শেষ ১৮ সেকেন্ডে ক্লোজ প্রাইসের দিকে যাবে
        targetWaypoint = target.close;
    }

    // প্রাইস মুভমেন্ট এবং নয়েজ
    const volatility = Math.abs(target.high - target.low) || (target.open * 0.0001);
    marketData.currentPrice += (targetWaypoint - marketData.currentPrice) * 0.05; 
    marketData.currentPrice += (Math.random() - 0.5) * (volatility * 0.1); 

    // প্রাইস যাতে হাই এবং লো এর বাইরে না যায় তা নিশ্চিত করা
    marketData.currentPrice = Math.max(target.low, Math.min(target.high, marketData.currentPrice));

    if (progress >= 0.98) marketData.currentPrice = target.close; // শেষ মুহূর্তে ক্লোজে ফিক্স

    liveCandle.close = roundPrice(marketData.currentPrice);
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, marketData.currentPrice));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, marketData.currentPrice));
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach(client => { if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) client.send(payload); });
}

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
                if (markets[msg.market]) ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) }));
            }
        } catch (_) {}
    });
});

// Cloudflare CDN Header
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=60');
        res.json(markets[marketId].history.slice(-300));
    } else { res.status(404).json({ error: 'Market not found' }); }
});

let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        ensureTargetCandle(markets[marketId], currentPeriod);
        updatePriceSmoothly(markets[marketId], currentPeriod);
        broadcastCandle(marketId, markets[marketId].history[markets[marketId].history.length - 1]);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const lastC = markets[marketId].history[markets[marketId].history.length-1];
            if (lastC) batchUpdates[`markets/${markets[marketId].marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Server Running - Pattern Injector Active'));
server.listen(process.env.PORT || 3000, () => console.log(`Server started`));