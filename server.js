// --- START: server.js (v23 - Natural Market Movement + Admin Control) ---

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
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminPatterns = {}; 

// Helper functions
function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Admin Control Listener ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId]; 
        }
    });
});

// 1. Normal Candle Generation (Natural & Random)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);

    // If it's a live normal candle, we just set the open price. 
    // The tick logic will build its shape naturally.
    if (isLive) {
        return {
            timestamp,
            open: roundPrice(safeOpen),
            high: roundPrice(safeOpen),
            low: roundPrice(safeOpen),
            close: roundPrice(safeOpen),
            isPredetermined: false // <-- This tells the server to move it randomly
        };
    }

    // Historical generation with mixed sizes for a realistic background
    const isGreen = Math.random() > 0.5;
    const rand = Math.random();
    let bodyFactor;
    
    if (rand < 0.15) bodyFactor = 0.00002; // Doji / small
    else if (rand < 0.4) bodyFactor = 0.00006; // Medium-small
    else if (rand < 0.8) bodyFactor = 0.00015; // Normal
    else bodyFactor = 0.0003; // Big body

    const body = bodyFactor * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (Math.random() * 0.00015) * safeOpen;
    const lowerWick = (Math.random() * 0.00015) * safeOpen;

    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(Math.max(safeOpen, close) + upperWick),
        low: roundPrice(Math.min(safeOpen, close) - lowerWick),
        close: roundPrice(close)
    };
}

// 2. Admin-Controlled Dynamic Candle Generation (Targeted Shape)
function generateDynamicCandle(timestamp, open, command) {
    let bodySize, upperWick, lowerWick, close, high, low;
    
    const stdBody = open * (0.0001 + Math.random() * 0.0001);
    const stdWick = open * (Math.random() * 0.00008);

    switch (command) {
        case 'GREEN':
            bodySize = stdBody; close = open + bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        case 'RED':
            bodySize = stdBody; close = open - bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        case 'BULLISH_MARUBOZU':
            bodySize = open * (0.00025 + Math.random() * 0.0001); close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU':
            bodySize = open * (0.00025 + Math.random() * 0.0001); close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 1.5); break;
        case 'RED_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 1.5); break;
        case 'GREEN_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = bodySize * (2 + Math.random() * 1.5); lowerWick = open * (Math.random() * 0.00002); break;
        case 'RED_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = bodySize * (2 + Math.random() * 1.5); lowerWick = open * (Math.random() * 0.00002); break;
        case 'DOJI':
            bodySize = open * (Math.random() * 0.00001); close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = open * (0.00005 + Math.random() * 0.0001); lowerWick = open * (0.00005 + Math.random() * 0.0001); break;
        default: 
            close = command === 'RED' ? open - stdBody : open + stdBody; upperWick = stdWick; lowerWick = stdWick;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(open), 
        low: roundPrice(open), 
        close: roundPrice(open), 
        isPredetermined: true, // <-- This tells the server to strictly follow the target
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
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice, false);
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

// Check for admin command before creating a new candle
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            console.log(`[ADMIN] Market: ${marketData.marketId}, Time: ${new Date(currentPeriod).toLocaleTimeString()}, Command: ${marketData.nextCandleCommand}`);
            marketData.nextCandleCommand = null; // Clear command
        } 
        else {
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    const adminColor = adminPattern.pattern[patternIndex];
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, adminColor);
                }
            }
        }
        
        // If no admin command, create a normal, natural candle
        if (!newCandle) {
            newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// Tick Movement Controller (Handles both Natural and Admin modes)
function updateRealisticPrice(marketData, candle, currentPeriod) {
    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);

    if (candle.isPredetermined) {
        // --- ADMIN MODE: Guided movement to target ---
        const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);
        const idealPrice = candle.open + (candle.targetClose - candle.open) * progress;
        const noiseFactor = 1 - progress; 
        const noise = (Math.random() - 0.5) * (candle.open * 0.0001) * noiseFactor;

        marketData.currentPrice = idealPrice + noise;
        marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
        marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

        // Lock exactly on target in the last second
        if (timeElapsed >= TIMEFRAME - 1000) {
            marketData.currentPrice = candle.targetClose;
        }
    } else {
        // --- NATURAL MODE: Realistic Random Walk ---
        const openPrice = candle.open;
        const baseVolatility = openPrice * 0.00004;

        let impulse = (Math.random() - 0.5) * baseVolatility * 2.0;
        let recoil = -(marketData.lastMove || 0) * 0.25; 
        let jitter = (Math.random() - 0.5) * (baseVolatility * 0.2);
        let finalMove = impulse + recoil + jitter;
        
        if (Math.random() < 0.08) finalMove *= 3.5; // Occasional natural spike

        marketData.currentPrice += finalMove;
        marketData.lastMove = finalMove;

        // Prevent it from wandering ridiculously far in a single minute
        const dist = marketData.currentPrice - openPrice;
        if (Math.abs(dist) > openPrice * 0.0008) {
            marketData.currentPrice -= finalMove * 1.5; 
        }
    }

    candle.close = roundPrice(marketData.currentPrice);
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
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

// Admin Command Endpoint
app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
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

        updateRealisticPrice(marketData, candle, currentPeriod); 
        broadcastCandle(marketId, candle);
    }

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

app.get('/ping', (_req, res) => res.send('UltraSmooth V23 - Natural & Admin Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---