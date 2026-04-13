// ========================================================
// FINAL server.js (Single Default Firebase - ictex-trade)
// ========================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- Main and Only Firebase Configuration ---
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

const MAX_CANDLES = 1500;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const marketTargets = {};

function roundPrice(v) { return parseFloat(Math.max(0.00001, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Listeners for Admin Commands and Market List ---

// Listen for admin's OHLC targets
db.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    Object.keys(marketTargets).forEach(key => delete marketTargets[key]);
    Object.assign(marketTargets, targets);
});

// Listen for market list updates from the default Firebase
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    
    // Initialize engine for new or updated markets
    Object.keys(fbMarkets).forEach((marketId) => {
        const marketData = fbMarkets[marketId];
        if ((marketData.type === 'otc' || marketData.type === 'broker_real') &&
            (marketData.status === 'active' || marketData.status === 'maintenance') &&
            !markets[marketId]) {
            initializeNewMarket(marketId);
            console.log(`[ENGINE] Started for market: ${marketId}`);
        }
    });
    
    // Stop engine for markets that were deleted
    Object.keys(markets).forEach(marketId => {
        if (!fbMarkets[marketId]) {
            delete markets[marketId];
            console.log(`[ENGINE] Stopped for deleted market: ${marketId}`);
        }
    });
});


// --- Candle Engine Logic ---

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
    } catch (e) {}

    const candles = [];
    let currentPrice = startPrice;
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const isGreen = Math.random() > 0.5;
        const body = currentPrice * 0.0002;
        const close = isGreen ? currentPrice + body : currentPrice - body;
        candles.push({
            timestamp: nowPeriod - (i * TIMEFRAME),
            open: roundPrice(currentPrice),
            high: roundPrice(Math.max(currentPrice, close) + body * 0.5),
            low: roundPrice(Math.min(currentPrice, close) - body * 0.5),
            close: roundPrice(close)
        });
        currentPrice = close;
    }

    markets[marketId] = {
        marketId, marketPath: path, history: candles,
        currentPrice: currentPrice,
    };
}

function generateNormalCandle(openPrice, timestamp) {
    const isGreen = Math.random() > 0.5;
    const body = openPrice * 0.0002 * (0.5 + Math.random());
    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + body * Math.random() * 0.7;
    const low = Math.min(openPrice, close) - body * Math.random() * 0.7;
    return { timestamp, open: roundPrice(openPrice), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };
}

function animatePuppetCandle(marketData, currentPeriodStart, currentCandle, target) {
    const now = Date.now();
    const progress = Math.min((now - currentPeriodStart) / TIMEFRAME, 1.0);
    let livePrice;

    if (progress < 0.3) {
        livePrice = target.open + (target.high - target.open) * (progress / 0.3);
    } else if (progress < 0.8) {
        livePrice = target.low + Math.random() * (target.high - target.low);
    } else {
        const finalPullProgress = (progress - 0.8) / 0.2;
        livePrice = marketData.currentPrice + (target.close - marketData.currentPrice) * finalPullProgress;
    }

    marketData.currentPrice = livePrice;
    if (progress >= 0.98) { // Force match at the end
        currentCandle.close = target.close;
        currentCandle.high = target.high;
        currentCandle.low = target.low;
    } else {
        currentCandle.close = roundPrice(livePrice);
        currentCandle.high = roundPrice(Math.max(currentCandle.high, livePrice));
        currentCandle.low = roundPrice(Math.min(currentCandle.low, livePrice));
    }
}

// --- Main Server Loop ---
let lastSyncSecond = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriodStart = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    
    for (const marketId in markets) {
        const marketData = markets[marketId];
        let lastCandle = marketData.history[marketData.history.length - 1];

        if (!lastCandle || currentPeriodStart > lastCandle.timestamp) {
            const openPrice = lastCandle ? lastCandle.close : 1.15;
            let newCandle;
            if (marketTargets[marketId]) {
                newCandle = { ...marketTargets[marketId], timestamp: currentPeriodStart };
                db.ref(`admin/market_targets/${marketId}`).remove(); // Clear command
                delete marketTargets[marketId];
            } else {
                newCandle = generateNormalCandle(openPrice, currentPeriodStart);
            }
            marketData.history.push(newCandle);
            if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
            lastCandle = newCandle;
        }

        animatePuppetCandle(marketData, currentPeriodStart, lastCandle, lastCandle);
        
        const liveCandleState = { ...lastCandle };
        liveCandleState.close = marketData.currentPrice;
        
        const payload = JSON.stringify({ market: marketId, candle: liveCandleState });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                client.send(payload);
            }
        });
    }

    // Update live price in Firebase for your user app
    const currentSecond = Math.floor(now / 1000);
    if (currentSecond % 2 === 0 && currentSecond !== lastSyncSecond) {
        lastSyncSecond = currentSecond;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            if (m.currentPrice) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: roundPrice(m.currentPrice), timestamp: now };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);


// --- API & WebSocket ---

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') ws.subscribedMarket = msg.market;
        } catch (e) {}
    });
});

app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId]?.history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market engine not running for this ID' });
    }
});

app.get('/ping', (_req, res) => res.send('Default DB Puppet Engine Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));