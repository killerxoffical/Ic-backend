const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ==========================================
// 1. DUAL FIREBASE CONFIGURATION
// ==========================================

// MAIN DATABASE (ictex-trade: For Users, Balances, Trade History, and Adding Markets)
const mainConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade",
    storageBucket: "ictex-trade.appspot.com",
    messagingSenderId: "755532704199",
    appId: "1:755532704199:web:b27d7c9e7d0f4ac76291e2"
};

// MARKET DATABASE (earning-xone-v1: For Live Candles & Admin Puppet Control)
const marketConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
};

// Initialize Both Apps
const mainApp = firebase.initializeApp(mainConfig, "MainApp");
const marketApp = firebase.initializeApp(marketConfig, "MarketApp");

const dbMain = mainApp.database();       // Read markets from here
const dbMarket = marketApp.database();   // Write live prices and read targets from here

// ==========================================
// 2. SERVER SETUP & VARIABLES
// ==========================================
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 1500; // Keep only 1500 candles in RAM per market
const TIMEFRAME = 60000;  // 1 Minute timeframe
const TICK_MS = 300;      // Price update speed (animation)
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300; // Seed fake history for empty markets

const markets = {};       // Memory storage for charts
const marketTargets = {}; // Admin's OHLC Targets

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// ==========================================
// 3. ADMIN PUPPET LISTENER & MARKET SYNC
// ==========================================

// Listen for exact OHLC targets set by admin (From New Market DB)
dbMarket.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    // Clear old targets
    for (let key in marketTargets) delete marketTargets[key];
    // Set new targets
    Object.keys(targets).forEach(marketId => {
        marketTargets[marketId] = targets[marketId];
    });
});

// 🔥 THE BRIDGE: Auto Sync Markets from MAIN DB to MARKET DB 🔥
dbMain.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    
    // 1. Auto-copy all markets to the new Firebase instantly!
    dbMarket.ref('admin/markets').set(fbMarkets).catch(err => console.error("Sync Error:", err));

    // 2. Initialize these markets in Render's Engine
    Object.keys(fbMarkets).forEach((marketId) => {
        const marketData = fbMarkets[marketId];
        // Start engine only for OTC/Broker active markets
        if ((marketData.type === 'otc' || marketData.type === 'broker_real') && 
            (marketData.status === 'active' || marketData.status === 'maintenance') && 
            !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// ==========================================
// 4. CANDLE GENERATOR & PUPPET ENGINE
// ==========================================

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15; 
    
    // Try to fetch the last known price to resume
    try {
        const liveSnap = await dbMarket.ref(`markets/${path}/live`).once('value');
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
            open: roundPrice(currentPrice),
            high: roundPrice(Math.max(currentPrice, close) + body * 0.5),
            low: roundPrice(Math.min(currentPrice, close) - body * 0.5),
            close: roundPrice(close)
        });
        currentPrice = close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        lastMove: 0
    };
    console.log(`[ENGINE] Started for ${marketId}.`);
}

// Normal Realistic Tick (When no admin command)
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

// PUPPET ENGINE: Forces price to perfectly match Admin's Target
function updatePuppetPrice(marketData, currentPeriodStart, currentCandle) {
    const target = marketTargets[marketData.marketId];
    
    // If no admin command, run normal market logic
    if (!target) {
        updateRealisticPrice(marketData, currentCandle);
        return;
    }

    const now = Date.now();
    const timeElapsed = now - currentPeriodStart; 
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0); 

    let currentLivePrice;

    if (progress < 0.3) {
        // Move towards target High/Low
        const distance = target.target_high - target.target_open;
        currentLivePrice = target.target_open + (distance * (progress / 0.3));
    } 
    else if (progress < 0.8) {
        // Fluctuate between High and Low
        const range = target.target_high - target.target_low;
        currentLivePrice = target.target_low + (Math.random() * range);
    } 
    else {
        // Forcefully match the Target Close at the end of the minute
        const remainingProgress = (progress - 0.8) / 0.2; 
        const distanceToClose = target.target_close - marketData.currentPrice;
        currentLivePrice = marketData.currentPrice + (distanceToClose * remainingProgress);
    }

    marketData.currentPrice = currentLivePrice;
    currentCandle.close = roundPrice(currentLivePrice);
    currentCandle.high = roundPrice(Math.max(currentCandle.high, currentLivePrice));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, currentLivePrice));

    // Perfect Match at 98% time
    if (progress >= 0.98) {
        currentCandle.close = target.target_close;
        currentCandle.high = target.target_high;
        currentCandle.low = target.target_low;
    }
}

// ==========================================
// 5. MAIN TICK LOOP (Runs 24/7)
// ==========================================
let lastSyncSecond = 0;

setInterval(() => {
    const now = Date.now();
    const currentPeriodStart = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentSecond = Math.floor(now / 1000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let lastCandle = marketData.history[marketData.history.length - 1];

        // 1. Detect New Minute
        if (!lastCandle || currentPeriodStart > lastCandle.timestamp) {
            
            // Delete target from Firebase so it doesn't repeat!
            if (marketTargets[marketId]) {
                dbMarket.ref(`admin/market_targets/${marketId}`).remove();
                delete marketTargets[marketId];
                console.log(`[PUPPET COMPLETED] ${marketId} matched target.`);
            }

            if (marketData.history.length >= MAX_CANDLES) {
                marketData.history.shift(); 
            }

            const openPrice = lastCandle ? lastCandle.close : 1.15;
            lastCandle = {
                timestamp: currentPeriodStart,
                open: openPrice,
                high: openPrice,
                low: openPrice,
                close: openPrice
            };
            marketData.history.push(lastCandle);
        }

        // 2. Animate Price
        updatePuppetPrice(marketData, currentPeriodStart, lastCandle);

        // 3. Broadcast to Live Users via WebSocket
        const payload = JSON.stringify({ market: marketId, candle: lastCandle, serverTime: now });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                client.send(payload);
            }
        });
    }

    // 4. Save Live Price to New Market DB
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
        dbMarket.ref().update(batchUpdates).catch(()=>{});
    }

}, TICK_MS);

// ==========================================
// 6. API & WEBSOCKET CONNECTIONS
// ==========================================

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
            }
        } catch (e) {}
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

app.get('/ping', (_req, res) => res.send('Dual DB Puppet Engine Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));