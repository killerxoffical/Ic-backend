// --- START: server.js (v23 - Full Admin Control + Realistic Candle Shapes) ---

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

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

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

// 🔥 Updated: Generates realistic random candles (Doji, Hammer, Normal)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const baseVolatility = safeOpen * (0.0001 + Math.random() * 0.0002);
    
    let targetColor = Math.random() > 0.5 ? 'GREEN' : 'RED';
    let bodySize = baseVolatility * (0.2 + Math.random() * 0.8);
    let upperWick = baseVolatility * Math.random();
    let lowerWick = baseVolatility * Math.random();

    // 30% chance to generate a special pattern for realistic looks
    const rand = Math.random();
    if (rand < 0.1) { // Doji (Cross)
        bodySize = baseVolatility * 0.05; upperWick = baseVolatility * 1.2; lowerWick = baseVolatility * 1.2;
    } else if (rand < 0.2) { // Hammer
        bodySize = baseVolatility * 0.6; upperWick = baseVolatility * 0.1; lowerWick = baseVolatility * 2; targetColor = 'GREEN';
    } else if (rand < 0.3) { // Shooting Star
        bodySize = baseVolatility * 0.6; upperWick = baseVolatility * 2; lowerWick = baseVolatility * 0.1; targetColor = 'RED';
    }

    const close = targetColor === 'GREEN' ? safeOpen + bodySize : safeOpen - bodySize;
    const finalHigh = Math.max(safeOpen, close) + upperWick;
    const finalLow = Math.min(safeOpen, close) - lowerWick;

    if (!isLive) {
        return {
            timestamp, open: roundPrice(safeOpen), high: roundPrice(finalHigh), low: roundPrice(finalLow), close: roundPrice(close)
        };
    }

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

// Admin-Controlled Dynamic Candle Generation
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
            bodySize = open * (0.0002 + Math.random() * 0.0001); close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU':
            bodySize = open * (0.0002 + Math.random() * 0.0001); close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 2); break;
        case 'RED_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 2); break;
        case 'GREEN_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = bodySize * (2 + Math.random() * 2); lowerWick = open * (Math.random() * 0.00002); break;
        case 'RED_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = bodySize * (2 + Math.random() * 2); lowerWick = open * (Math.random() * 0.00002); break;
        case 'DOJI':
            bodySize = open * (Math.random() * 0.00001); close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = open * (0.00005 + Math.random() * 0.0001); lowerWick = open * (0.00005 + Math.random() * 0.0001); break;
        default: 
            close = command === 'RED' ? open - stdBody : open + stdBody; upperWick = stdWick; lowerWick = stdWick;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(open), low: roundPrice(open), close: roundPrice(open),
        isPredetermined: true, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: command
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

    markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice: currentPrice, lastMove: 0 };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            marketData.nextCandleCommand = null;
        } else {
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    const adminColor = adminPattern.pattern[patternIndex];
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, adminColor);
                }
            }
        }
        
        if (!newCandle) newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// 🔥 Updated: Perfect Animation Path to create beautiful wicks
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    let idealPrice;
    
    // Custom animation path: Open -> Wick -> Wick -> Close
    if (progress < 0.35) {
        // First 35% of time: Go to the "opposite" wick (creates the tail)
        const target = candle.targetClose > candle.open ? candle.targetLow : candle.targetHigh;
        const p = progress / 0.35;
        idealPrice = candle.open + (target - candle.open) * (p * (2 - p)); // easeOut
    } else if (progress < 0.75) {
        // Next 40% of time: Swing to the main direction's wick
        const start = candle.targetClose > candle.open ? candle.targetLow : candle.targetHigh;
        const target = candle.targetClose > candle.open ? candle.targetHigh : candle.targetLow;
        const p = (progress - 0.35) / 0.40;
        idealPrice = start + (target - start) * (-(Math.cos(Math.PI * p) - 1) / 2); // easeInOut
    } else {
        // Last 25% of time: Settle down to the exact close price
        const start = candle.targetClose > candle.open ? candle.targetHigh : candle.targetLow;
        const target = candle.targetClose;
        const p = (progress - 0.75) / 0.25;
        idealPrice = start + (target - start) * (p * (2 - p)); // easeOut
    }

    // Add micro-noise so it looks organic
    const noise = (Math.random() - 0.5) * (candle.open * 0.00005);
    marketData.currentPrice = idealPrice + noise;

    // Constrain to pre-calculated High/Low
    marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
    marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

    // Snap to exact close at the very end
    if (timeElapsed >= TIMEFRAME - 1000) {
        marketData.currentPrice = candle.targetClose;
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

app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (!marketId || !command) return res.status(400).json({ error: 'Missing marketId or command' });
    
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        res.json({ success: true, message: `Command ${command} received` });
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

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
                batchUpdates[`markets/${m.marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V23 - Realistic Wicks + Admin Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));