// ==========================================
// server.js (Single Firebase - Final Version)
// ==========================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ONLY ONE FIREBASE: earning-xone-v1
const firebaseConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
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
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const marketTargets = {};

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for exact OHLC targets set by admin
db.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    for (let key in marketTargets) delete marketTargets[key];
    Object.keys(targets).forEach(marketId => {
        marketTargets[marketId] = targets[marketId];
    });
});

// Listen to Market List directly from this Firebase
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const marketData = fbMarkets[marketId];
        if ((marketData.type === 'otc' || marketData.type === 'broker_real') &&
            (marketData.status === 'active' || marketData.status === 'maintenance') &&
            !markets[marketId]) {
            initializeNewMarket(marketId);
            console.log(`[SYNC] Detected and started engine for: ${marketId}`);
        }
    });
});

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
        const isGreen = Math.random() > 0.5;
        const body = currentPrice * 0.0002;
        const close = isGreen ? currentPrice + body : currentPrice - body;
        candles.push({
            timestamp: nowPeriod - (i * TIMEFRAME),
            open: roundPrice(currentPrice), high: roundPrice(Math.max(currentPrice, close) + body * 0.5),
            low: roundPrice(Math.min(currentPrice, close) - body * 0.5), close: roundPrice(close)
        });
        currentPrice = close;
    }

    markets[marketId] = {
        marketId, marketPath: path, history: candles,
        currentPrice: currentPrice, lastMove: 0
    };
}

function updateRealisticPrice(marketData, currentCandle) {
    if (Math.random() < 0.35) return;
    const openPrice = currentCandle.open;
    const baseVolatility = openPrice * 0.00005;
    let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
    marketData.currentPrice += impulse;
    currentCandle.close = roundPrice(marketData.currentPrice);
    currentCandle.high = roundPrice(Math.max(currentCandle.high, currentCandle.close));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, currentCandle.close));
}

function updatePuppetPrice(marketData, currentPeriodStart, currentCandle) {
    const target = marketTargets[marketData.marketId];
    if (!target) {
        updateRealisticPrice(marketData, currentCandle);
        return;
    }
    const now = Date.now();
    const timeElapsed = now - currentPeriodStart;
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);
    let currentLivePrice;
    if (progress < 0.3) {
        const distance = target.target_high - target.target_open;
        currentLivePrice = target.target_open + (distance * (progress / 0.3));
    } else if (progress < 0.8) {
        const range = target.target_high - target.target_low;
        currentLivePrice = target.target_low + (Math.random() * range);
    } else {
        const remainingProgress = (progress - 0.8) / 0.2;
        const distanceToClose = target.target_close - marketData.currentPrice;
        currentLivePrice = marketData.currentPrice + (distanceToClose * remainingProgress);
    }
    marketData.currentPrice = currentLivePrice;
    currentCandle.close = roundPrice(currentLivePrice);
    currentCandle.high = roundPrice(Math.max(currentCandle.high, currentLivePrice));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, currentCandle.close));
    if (progress >= 0.98) {
        currentCandle.close = target.target_close;
        currentCandle.high = target.target_high;
        currentCandle.low = target.target_low;
    }
}

let lastSyncSecond = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriodStart = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentSecond = Math.floor(now / 1000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let lastCandle = marketData.history[marketData.history.length - 1];

        if (!lastCandle || currentPeriodStart > lastCandle.timestamp) {
            if (marketTargets[marketId]) {
                db.ref(`admin/market_targets/${marketId}`).remove();
                delete marketTargets[marketId];
            }
            if (marketData.history.length >= MAX_CANDLES) marketData.history.shift();
            const openPrice = lastCandle ? lastCandle.close : 1.15;
            lastCandle = {
                timestamp: currentPeriodStart, open: openPrice, high: openPrice,
                low: openPrice, close: openPrice
            };
            marketData.history.push(lastCandle);
        }

        updatePuppetPrice(marketData, currentPeriodStart, lastCandle);

        const payload = JSON.stringify({ market: marketId, candle: lastCandle, serverTime: now });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                client.send(payload);
            }
        });
    }

    if (currentSecond % 2 === 0 && currentSecond !== lastSyncSecond) {
        lastSyncSecond = currentSecond;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length - 1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = {
                    price: lastC.close,
                    timestamp: lastC.timestamp
                };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

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
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

app.get('/ping', (_req, res) => res.send('Single DB Puppet Engine Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));