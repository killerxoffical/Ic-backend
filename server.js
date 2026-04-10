// --- START OF FILE server.js ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ==========================================
// 1. FIREBASE CONFIGURATION
// ==========================================
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

const TIMEFRAME = 60000; 
const TICK_MS = 300; 
const MAX_LOCAL_CANDLES = 120; 

const markets = {}; 
const adminSignals = {}; // Secret path storage

function roundPrice(v) { return parseFloat(v.toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for active markets
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const market = fbMarkets[marketId];
        if (market.status === 'active' && (market.type === 'otc' || market.type === 'broker_real')) {
            if (!markets[marketId]) initializeNewMarket(marketId, market.name);
        }
    });
});

// 🔥 Listen to Secret Admin Signals 🔥
db.ref('admin/market_signals').on('value', (snapshot) => {
    const signals = snapshot.val() || {};
    Object.keys(signals).forEach(marketId => {
        adminSignals[marketId] = signals[marketId];
    });
});

async function initializeNewMarket(marketId, marketName) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15500; 
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.exists() && liveSnap.val().price) startPrice = liveSnap.val().price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    for (let i = 60; i > 0; i--) {
        const c = buildCandle(nowPeriod - (i * TIMEFRAME), currentPrice, Math.random() > 0.5 ? 'UP' : 'DOWN', false);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice: currentPrice };
}

// 🔥 BUILD CANDLE LOGIC 🔥
function buildCandle(timestamp, open, direction, isForced = false) {
    const baseVolatility = open * (0.0001 + Math.random() * 0.0003);
    const bodySize = isForced ? baseVolatility * 1.5 : baseVolatility * (0.3 + Math.random() * 0.7);

    let close, high, low;

    if (direction === 'UP') {
        close = open + bodySize;
        // If forced, NO LOWER WICK (High = close + wick, Low = exactly open)
        high = close + (baseVolatility * Math.random());
        low = isForced ? open : open - (baseVolatility * Math.random()); 
    } else { // DOWN
        close = open - bodySize;
        // If forced, NO UPPER WICK (High = exactly open, Low = close - wick)
        high = isForced ? open : open + (baseVolatility * Math.random()); 
        low = close - (baseVolatility * Math.random());
    }

    // IMPORTANT: Sending 'isForced' flag to client!
    return { timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close), isForced };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        const signal = adminSignals[marketData.marketId];

        // Apply Admin Signal
        if (signal && signal.type && (signal.type === 'UP' || signal.type === 'DOWN')) {
            console.log(`✅ [ADMIN SIGNAL EXECUTED] ${marketData.marketId} -> ${signal.type}`);
            newCandle = buildCandle(currentPeriod, lastCandle.close, signal.type, true); // true = isForced
            
            // Delete signal after use
            db.ref(`admin/market_signals/${marketData.marketId}`).remove();
            delete adminSignals[marketData.marketId];
        } else {
            // Normal Random Candle
            newCandle = buildCandle(currentPeriod, lastCandle.close, Math.random() > 0.5 ? 'UP' : 'DOWN', false);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_LOCAL_CANDLES) marketData.history.shift();

        // Backup final candle to Firebase
        db.ref(`markets/${marketData.marketPath}/candles/60s/${lastCandle.timestamp}`).set(lastCandle).catch(()=>{});
        
        return newCandle;
    }
    return lastCandle;
}

// Live tick movement
function updateRealisticPrice(marketData, candle) {
    if (Math.random() < 0.3) return; 
    const pull = (candle.close - marketData.currentPrice) * 0.15; 
    const noise = (Math.random() - 0.5) * (candle.open * 0.00005);
    marketData.currentPrice += (pull + noise);
    marketData.currentPrice = Math.max(candle.low, Math.min(candle.high, marketData.currentPrice));
    candle.currentLivePrice = roundPrice(marketData.currentPrice);
}

// Broadcast to Client via WebSocket
function broadcastCandle(marketId, candle) {
    const liveCandle = { ...candle, close: candle.currentLivePrice || candle.open };
    const payload = JSON.stringify({ type: 'subscribed', market: marketId, candle: liveCandle });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe') ws.subscribedMarket = msg.market;
        } catch (_) {}
    });
});

// Main Loop
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;
        updateRealisticPrice(marketData, candle);
        broadcastCandle(marketId, candle);
    }
}, TICK_MS);

// Backup Live Price to DB every 2s
setInterval(() => {
    Object.keys(markets).forEach(marketId => {
        const m = markets[marketId];
        db.ref(`markets/${m.marketPath}/live`).set({ price: m.currentPrice, timestamp: Date.now() }).catch(()=>{});
    });
}, 2000);

// 🔥 AUTO STORAGE CLEANUP: Deletes candles older than 2 hours so Firebase 1GB limit never fills up
setInterval(() => {
    console.log("[CLEANUP] Removing old candles from Firebase...");
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000);
    Object.keys(markets).forEach(marketId => {
        const ref = db.ref(`markets/${markets[marketId].marketPath}/candles/60s`);
        ref.orderByKey().endAt(String(twoHoursAgo)).once('value', (snapshot) => {
            if (snapshot.exists()) {
                const updates = {};
                snapshot.forEach(child => { updates[child.key] = null; });
                ref.update(updates);
            }
        });
    });
}, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Server Engine Running on ${PORT}`));
// --- END OF FILE ---