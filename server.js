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

// ==========================================
// 2. SERVER SETTINGS
// ==========================================
const TIMEFRAME = 60000; // 1 minute candle
const TICK_MS = 300; // WebSocket update rate
const HISTORY_SEED_COUNT = 60; // How many candles to generate on boot
const MAX_LOCAL_CANDLES = 120; // Candles to keep in RAM

const markets = {}; // In-memory active markets
const adminOverrides = {}; // Stores UP/DOWN commands from Admin

function roundPrice(v) { return parseFloat(v.toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// ==========================================
// 3. LISTEN TO ADMIN COMMANDS & MARKETS
// ==========================================

// Listen for new markets added from your 'market add.html'
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const market = fbMarkets[marketId];
        if (market.status === 'active' && (market.type === 'otc' || market.type === 'broker_real')) {
            if (!markets[marketId]) {
                console.log(`[+] Initializing New Market: ${market.name}`);
                initializeNewMarket(marketId, market.name);
            }
        }
    });
});

// 🔥 THE FIX: Listen for Direct Admin UP/DOWN Commands 🔥
db.ref('admin/market_overrides').on('value', (snapshot) => {
    const overrides = snapshot.val() || {};
    Object.keys(overrides).forEach(marketId => {
        // Example command from admin: { type: 'UP', timestamp: 167... }
        adminOverrides[marketId] = overrides[marketId];
    });
});


// ==========================================
// 4. CANDLE GENERATION LOGIC
// ==========================================

async function initializeNewMarket(marketId, marketName) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15500; // Default price

    // Try to get last price from Firebase
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.exists() && liveSnap.val().price) {
            startPrice = liveSnap.val().price;
        }
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    // Seed historical candles
    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateRandomCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        name: marketName,
        history: candles,
        currentPrice: currentPrice,
        lastMove: 0
    };
}

function generateRandomCandle(timestamp, open) {
    const isGreen = Math.random() > 0.5;
    return buildCandle(timestamp, open, isGreen ? 'UP' : 'DOWN');
}

function generateAdminForcedCandle(timestamp, open, commandType) {
    // commandType is 'UP' or 'DOWN'
    return buildCandle(timestamp, open, commandType);
}

function buildCandle(timestamp, open, direction) {
    const baseVolatility = open * (0.0001 + Math.random() * 0.0003);
    const bodySize = baseVolatility * (0.3 + Math.random() * 0.7);
    const upperWick = baseVolatility * Math.random();
    const lowerWick = baseVolatility * Math.random();

    let close, high, low;

    if (direction === 'UP') {
        close = open + bodySize;
        high = close + upperWick;
        low = open - lowerWick;
    } else { // DOWN
        close = open - bodySize;
        high = open + upperWick;
        low = close - lowerWick;
    }

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(high),
        low: roundPrice(low),
        close: roundPrice(close)
    };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    // Time for a new candle!
    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        const override = adminOverrides[marketData.marketId];

        // 🔥 CHECK ADMIN COMMAND 🔥
        if (override && override.type && (override.type === 'UP' || override.type === 'DOWN')) {
            console.log(`[ADMIN FORCED] Market: ${marketData.marketId} | Direction: ${override.type}`);
            newCandle = generateAdminForcedCandle(currentPeriod, lastCandle.close, override.type);
            
            // Delete the command from Firebase so it doesn't repeat forever
            db.ref(`admin/market_overrides/${marketData.marketId}`).remove();
            delete adminOverrides[marketData.marketId];
        } 
        // 🎲 RANDOM CANDLE 🎲
        else {
            newCandle = generateRandomCandle(currentPeriod, lastCandle.close);
        }

        // Save new candle to RAM
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_LOCAL_CANDLES) marketData.history.shift();

        // Backup completed candle to Firebase
        backupCandleToFirebase(marketData.marketPath, lastCandle);

        return newCandle;
    }
    
    return lastCandle;
}

// Realistic Live Tick Movement (Jitter)
function updateRealisticPrice(marketData, candle) {
    if (Math.random() < 0.3) return; // Pause for realism

    const openPrice = candle.open;
    const targetClose = candle.close;
    
    // Smoothly pull current price towards the pre-calculated target close
    const pull = (targetClose - marketData.currentPrice) * 0.1;
    const noise = (Math.random() - 0.5) * (openPrice * 0.00005);
    
    let finalMove = pull + noise;

    marketData.currentPrice += finalMove;
    
    // Ensure we don't cross the predefined high/low wicks
    marketData.currentPrice = Math.max(candle.low, Math.min(candle.high, marketData.currentPrice));

    // Update live candle data
    candle.currentLivePrice = roundPrice(marketData.currentPrice);
}

// ==========================================
// 5. WEBSOCKET & SYNC LOGIC
// ==========================================

function broadcastCandle(marketId, candle) {
    // Send the candle with the 'currentLivePrice' replacing the 'close' for the live animation
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
            if (msg.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
            }
        } catch (_) {}
    });
});

// REST API to serve history to clients when they first load the chart
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        // Only send closed candles, exclude the currently forming one
        res.json(markets[marketId].history.slice(0, -1));
    } else {
        res.json([]);
    }
});

app.get('/ping', (_req, res) => res.send('ICTEX Trading Server V22 - Admin Control Active'));

// ==========================================
// 6. FIREBASE DATABASE BACKUP & CLEANUP
// ==========================================

function backupCandleToFirebase(marketPath, candle) {
    // Save to 60s timeframe path
    db.ref(`markets/${marketPath}/candles/60s/${candle.timestamp}`).set(candle).catch(()=>{});
    // Update live price for quick fetch
    db.ref(`markets/${marketPath}/live`).set({ price: candle.close, timestamp: candle.timestamp }).catch(()=>{});
}

// 🔥 AUTO CLEANUP: Prevent Firebase 1GB Limit from reaching 🔥
function cleanupOldFirebaseData() {
    console.log("[CLEANUP] Checking for old candles to delete from Firebase...");
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000); // 2 hours

    Object.keys(markets).forEach(marketId => {
        const path = markets[marketId].marketPath;
        const ref = db.ref(`markets/${path}/candles/60s`);
        
        // Find candles older than 2 hours and delete them
        ref.orderByKey().endAt(String(twoHoursAgo)).once('value', (snapshot) => {
            if (snapshot.exists()) {
                const updates = {};
                snapshot.forEach(child => { updates[child.key] = null; });
                ref.update(updates);
                console.log(`[CLEANUP] Deleted ${Object.keys(updates).length} old candles for ${marketId}`);
            }
        });
    });
}

// Run cleanup every 30 minutes
setInterval(cleanupOldFirebaseData, 30 * 60 * 1000);

// ==========================================
// 7. MAIN TICK LOOP
// ==========================================

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


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 ICTEX Trade Server Running on PORT ${PORT}`);
    console.log(`🛡️ Admin Direct Control (Overrides): ACTIVE`);
    console.log(`🧹 Auto Storage Cleanup: ACTIVE`);
});
// --- END OF FILE ---