// ========================================================
// FINAL server.js (Dual Firebase + Auto Sync + Puppet Engine)
// ========================================================

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// 1. DUAL FIREBASE CONFIGURATION
const mainConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade",
    storageBucket: "ictex-trade.appspot.com",
    messagingSenderId: "755532704199",
    appId: "1:755532704199:web:b27d7c9e7d0f4ac76291e2"
};

const marketConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
};

const mainApp = firebase.initializeApp(mainConfig, "MainApp");
const marketApp = firebase.initializeApp(marketConfig, "MarketApp");

const dbMain = mainApp.database();
const dbMarket = marketApp.database();

// 2. SERVER SETUP
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 1500;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const HISTORY_SEED_COUNT = 300;

const markets = {}; // RAM storage for candles
const marketTargets = {}; // Admin commands cache

function roundPrice(v) { return parseFloat(Math.max(0.00001, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// 3. LISTENERS & SYNC LOGIC

// Listen for admin OHLC targets from the new Market DB
dbMarket.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    Object.keys(marketTargets).forEach(key => delete marketTargets[key]); // Clear cache
    Object.assign(marketTargets, targets); // Load new targets
});

// 🔥 THE BRIDGE: Auto-sync markets from MAIN DB (ictex-trade) to MARKET DB (earning-xone)
dbMain.ref('admin/markets').on('value', (snapshot) => {
    const mainDbMarkets = snapshot.val() || {};
    
    // Auto-copy the entire market list to the new Firebase. This is the sync magic!
    dbMarket.ref('admin/markets').set(mainDbMarkets)
      .then(() => console.log('[SYNC] Successfully synced market list to earning-xone-v1.'))
      .catch(err => console.error("[SYNC ERROR]", err));

    // Initialize or update the engine for each market
    Object.keys(mainDbMarkets).forEach((marketId) => {
        const marketData = mainDbMarkets[marketId];
        if ((marketData.type === 'otc' || marketData.type === 'broker_real') &&
            (marketData.status === 'active' || marketData.status === 'maintenance') &&
            !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
    
    // Cleanup: Remove markets from engine if they are deleted from main DB
    Object.keys(markets).forEach(marketId => {
        if (!mainDbMarkets[marketId]) {
            delete markets[marketId];
            console.log(`[ENGINE] Stopped and removed engine for ${marketId}.`);
        }
    });
});

// 4. CANDLE ENGINE LOGIC

async function initializeNewMarket(marketId) {
    const candles = [];
    let currentPrice = 1.15; // Default start price
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
        marketId,
        history: candles,
        currentPrice: currentPrice
    };
    console.log(`[ENGINE] Started for ${marketId}.`);
}

// Generates a normal random candle when no admin command is active
function generateNormalCandle(openPrice, timestamp) {
    const isGreen = Math.random() > 0.5;
    const body = openPrice * 0.0002 * (0.5 + Math.random());
    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + body * Math.random() * 0.7;
    const low = Math.min(openPrice, close) - body * Math.random() * 0.7;
    return { timestamp, open: roundPrice(openPrice), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };
}

// Animates the price smoothly towards the target OHLC
function animatePuppetCandle(marketData, currentPeriodStart, currentCandle, target) {
    const now = Date.now();
    const progress = Math.min((now - currentPeriodStart) / TIMEFRAME, 1.0);

    let livePrice;
    if (progress < 0.3) {
        livePrice = target.target_open + (target.target_high - target.target_open) * (progress / 0.3);
    } else if (progress < 0.8) {
        livePrice = target.target_low + Math.random() * (target.target_high - target.target_low);
    } else {
        const finalPullProgress = (progress - 0.8) / 0.2;
        livePrice = marketData.currentPrice + (target.target_close - marketData.currentPrice) * finalPullProgress;
    }

    marketData.currentPrice = livePrice;
    currentCandle.close = roundPrice(livePrice);
    currentCandle.high = roundPrice(Math.max(currentCandle.high, livePrice));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, livePrice));

    if (progress >= 0.98) {
        currentCandle.close = target.target_close;
        currentCandle.high = target.target_high;
        currentCandle.low = target.target_low;
    }
}

// 5. MAIN SERVER LOOP (The Heartbeat)

setInterval(() => {
    const now = Date.now();
    const currentPeriodStart = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let lastCandle = marketData.history[marketData.history.length - 1];

        // --- New Candle Creation Logic ---
        if (!lastCandle || currentPeriodStart > lastCandle.timestamp) {
            const openPrice = lastCandle ? lastCandle.close : 1.15;
            let newCandle;

            if (marketTargets[marketId]) {
                // If admin set a target, use that for the new candle
                newCandle = { ...marketTargets[marketId], timestamp: currentPeriodStart };
                dbMarket.ref(`admin/market_targets/${marketId}`).remove(); // Clear command after using it
                delete marketTargets[marketId];
                console.log(`[PUPPET] Executing admin target for ${marketId}.`);
            } else {
                // Otherwise, generate a normal random candle
                newCandle = generateNormalCandle(openPrice, currentPeriodStart);
            }
            
            marketData.history.push(newCandle);
            if (marketData.history.length > MAX_CANDLES) {
                marketData.history.shift();
            }
            lastCandle = newCandle;
        }

        // --- Live Price Animation Logic ---
        const targetForThisCandle = lastCandle; // The target IS the current candle itself
        animatePuppetCandle(marketData, currentPeriodStart, lastCandle, targetForThisCandle);
        
        // --- Broadcast to Users ---
        const liveCandleState = { ...lastCandle };
        liveCandleState.close = marketData.currentPrice; // Send the animated live price
        
        const payload = JSON.stringify({ market: marketId, candle: liveCandleState });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                client.send(payload);
            }
        });
    }
}, TICK_MS);


// 6. API & WEBSOCKET SETUP

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') ws.subscribedMarket = msg.market;
        } catch (e) {}
    });
});

// API for loading initial 1500 candle history
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId]?.history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market engine not running or not found' });
    }
});

app.get('/ping', (_req, res) => res.send('Auto-Sync Puppet Engine Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server is live on port ${PORT}`));