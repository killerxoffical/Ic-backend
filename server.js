// --- START: server.js (v22 - Full Admin Control with Perfect Animation) ---

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
app.use(express.json()); // For parsing admin API bodies
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; // Server's internal market data
const adminPatterns = {}; // Local cache for admin patterns

// Helper functions
function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Admin Control Listener ---
// This continuously listens for admin commands from Firebase
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId]; // Remove if not active
        }
    });
});

// Candle Generation Logic (Updated for Live Animation)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    const body = (0.00006 + Math.random() * 0.00025) * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
    const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;

    const finalHigh = Math.max(safeOpen, close) + upperWick;
    const finalLow = Math.min(safeOpen, close) - lowerWick;

    // For fast historical load, return direct values
    if (!isLive) {
        return {
            timestamp,
            open: roundPrice(safeOpen),
            high: roundPrice(finalHigh),
            low: roundPrice(finalLow),
            close: roundPrice(close)
        };
    }

    // For live tracking, set targets and start from open
    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(safeOpen),
        low: roundPrice(safeOpen),
        close: roundPrice(safeOpen),
        isPredetermined: true,
        targetHigh: roundPrice(finalHigh),
        targetLow: roundPrice(finalLow),
        targetClose: roundPrice(close)
    };
}

// Admin-Controlled Dynamic Candle Generation (Updated for Live Animation)
function generateDynamicCandle(timestamp, open, command) {
    let bodySize, upperWick, lowerWick, close, high, low;
    
    // Default standard volatility
    const stdBody = open * (0.0001 + Math.random() * 0.0001);
    const stdWick = open * (Math.random() * 0.00008);

    switch (command) {
        case 'GREEN':
            bodySize = stdBody; close = open + bodySize;
            upperWick = stdWick; lowerWick = stdWick;
            break;
        case 'RED':
            bodySize = stdBody; close = open - bodySize;
            upperWick = stdWick; lowerWick = stdWick;
            break;
        case 'BULLISH_MARUBOZU':
            bodySize = open * (0.0002 + Math.random() * 0.0001);
            close = open + bodySize;
            upperWick = 0; lowerWick = 0;
            break;
        case 'BEARISH_MARUBOZU':
            bodySize = open * (0.0002 + Math.random() * 0.0001);
            close = open - bodySize;
            upperWick = 0; lowerWick = 0;
            break;
        case 'GREEN_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005);
            close = open + bodySize;
            upperWick = open * (Math.random() * 0.00002);
            lowerWick = bodySize * (2 + Math.random() * 2); // 2x-4x body
            break;
        case 'RED_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005);
            close = open - bodySize;
            upperWick = open * (Math.random() * 0.00002);
            lowerWick = bodySize * (2 + Math.random() * 2);
            break;
        case 'GREEN_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005);
            close = open + bodySize;
            upperWick = bodySize * (2 + Math.random() * 2);
            lowerWick = open * (Math.random() * 0.00002);
            break;
        case 'RED_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005);
            close = open - bodySize;
            upperWick = bodySize * (2 + Math.random() * 2);
            lowerWick = open * (Math.random() * 0.00002);
            break;
        case 'DOJI':
            bodySize = open * (Math.random() * 0.00001); // almost equal
            close = Math.random() > 0.5 ? open + bodySize : open - bodySize;
            upperWick = open * (0.00005 + Math.random() * 0.0001);
            lowerWick = open * (0.00005 + Math.random() * 0.0001);
            break;
        default: // Fallback to normal GREEN/RED if missing
            close = command === 'RED' ? open - stdBody : open + stdBody;
            upperWick = stdWick; lowerWick = stdWick;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(open), // Start at open
        low: roundPrice(open), // Start at open
        close: roundPrice(open), // Start at open
        isPredetermined: true,
        targetHigh: roundPrice(high),
        targetLow: roundPrice(low),
        targetClose: roundPrice(close),
        pattern: command
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
    const candles = [];
    let currentPrice = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice, false); // isLive = false for history
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        lastMove: 0
    };
}

// 🔥 Core Function: Checks for admin command before creating a new candle
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        // 1. Immediate Next Candle Command Check
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            console.log(`[ADMIN-IMMEDIATE] Market: ${marketData.marketId}, Time: ${new Date(currentPeriod).toLocaleTimeString()}, Set to: ${marketData.nextCandleCommand}`);
            // Clear command since it's consumed!
            marketData.nextCandleCommand = null;
        } 
        // 2. Fallback to Firebase Scheduled Pattern
        else {
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    const adminColor = adminPattern.pattern[patternIndex];
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, adminColor);
                    console.log(`[ADMIN-PATTERN] Market: ${marketData.marketId}, Time: ${new Date(currentPeriod).toLocaleTimeString()}, Set to: ${adminColor}`);
                }
            }
        }
        
        // 3. Normal Historical Candle
        if (!newCandle) {
            newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true); // isLive = true
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// Realistic Tick Movement (Updated to respect Admin Targets perfectly)
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    // Interpolate toward the target close
    const idealPrice = candle.open + (candle.targetClose - candle.open) * progress;

    // Add diminishing noise (Noise reduces to 0 at the end of the minute)
    const noiseFactor = 1 - progress; 
    const noise = (Math.random() - 0.5) * (candle.open * 0.0001) * noiseFactor;

    marketData.currentPrice = idealPrice + noise;

    // Constrain within target high/low boundaries
    marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
    marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

    // In the last 1 second, lock it exactly to the target close to ensure accuracy
    if (timeElapsed >= TIMEFRAME - 1000) {
        marketData.currentPrice = candle.targetClose;
    }

    candle.close = roundPrice(marketData.currentPrice);
    // Expand high/low dynamically as the price moves
    candle.high = roundPrice(Math.max(candle.high, candle.close, candle.open));
    candle.low = roundPrice(Math.min(candle.low, candle.close, candle.open));
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(payload);
        }
    });
}

// Market listener
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        // Only initialize controllable markets
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                // Send history on subscribe
                if (markets[msg.market]) {
                    const historyPayload = { type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) };
                    ws.send(JSON.stringify(historyPayload));
                }
            }
        } catch (_) {}
    });
});

// App endpoint to serve history for admin panel & initial load
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

// Admin Command REST API Endpoint
app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        console.log(`[API] Admin commanded Next Candle for ${marketId} to be ${command}`);
        res.json({ success: true, message: `Command ${command} received for ${marketId}` });
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Main Loop
let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;

        // Apply real-time animation calculation
        updateRealisticPrice(marketData, candle, currentPeriod); 
        broadcastCandle(marketId, candle);
    }

    // Backup to Firebase every minute
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
        db.ref().update(batchUpdates).catch(()=>{});
        console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up.`);
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V22 - Full Admin Control Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---