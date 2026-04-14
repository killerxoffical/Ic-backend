// --- START: server.js (v26 - Smooth & Low Volatility Real Market) ---

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

// 🔥 Low Volatility Target Generator 🔥
function generateCandleTargets(timestamp, open, command) {
    let isGreen, bodySize, upperWick, lowerWick, patternType;
    
    // V26: Base Volatility dramatically reduced for smooth realistic look
    const baseVol = open * (0.00003 + Math.random() * 0.00006);

    // 1. NATURAL MARKET GENERATION
    if (command === 'NATURAL') {
        isGreen = Math.random() > 0.5;
        
        // Controlled, smaller bodies and wicks
        bodySize = baseVol * (0.2 + Math.random() * 0.8);
        upperWick = baseVol * (Math.random() * 0.6);
        lowerWick = baseVol * (Math.random() * 0.6);
        
        patternType = 'NORMAL';
    } 
    // 2. ADMIN COMMAND GENERATION
    else {
        switch (command) {
            case 'GREEN':
                bodySize = baseVol * (0.6 + Math.random() * 0.4); upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5; isGreen = true; patternType = 'NORMAL'; break;
            case 'RED':
                bodySize = baseVol * (0.6 + Math.random() * 0.4); upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5; isGreen = false; patternType = 'NORMAL'; break;
            case 'BULLISH_MARUBOZU':
                bodySize = baseVol * 2.0; upperWick = 0; lowerWick = 0; isGreen = true; patternType = 'MARUBOZU'; break;
            case 'BEARISH_MARUBOZU':
                bodySize = baseVol * 2.0; upperWick = 0; lowerWick = 0; isGreen = false; patternType = 'MARUBOZU'; break;
            case 'GREEN_HAMMER':
                bodySize = baseVol * 0.4; upperWick = baseVol * 0.1; lowerWick = baseVol * 1.5; isGreen = true; patternType = 'HAMMER'; break;
            case 'RED_HAMMER':
                bodySize = baseVol * 0.4; upperWick = baseVol * 0.1; lowerWick = baseVol * 1.5; isGreen = false; patternType = 'HAMMER'; break;
            case 'GREEN_SHOOTING_STAR':
                bodySize = baseVol * 0.4; upperWick = baseVol * 1.5; lowerWick = baseVol * 0.1; isGreen = true; patternType = 'SHOOTING_STAR'; break;
            case 'RED_SHOOTING_STAR':
                bodySize = baseVol * 0.4; upperWick = baseVol * 1.5; lowerWick = baseVol * 0.1; isGreen = false; patternType = 'SHOOTING_STAR'; break;
            case 'DOJI':
                bodySize = baseVol * 0.05; upperWick = baseVol * 1.0; lowerWick = baseVol * 1.0; isGreen = Math.random() > 0.5; patternType = 'DOJI'; break;
            default:
                bodySize = baseVol; upperWick = baseVol * 0.4; lowerWick = baseVol * 0.4; isGreen = true; patternType = 'NORMAL';
        }
    }

    const close = isGreen ? open + bodySize : open - bodySize;
    const high = Math.max(open, close) + upperWick;
    const low = Math.min(open, close) - lowerWick;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(open), 
        low: roundPrice(open),  
        close: roundPrice(open),
        targetHigh: roundPrice(high),
        targetLow: roundPrice(low),
        targetClose: roundPrice(close),
        pattern: patternType,
        isGreen: isGreen
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
        const target = generateCandleTargets(nowPeriod - (i * TIMEFRAME), currentPrice, 'NATURAL');
        candles.push({
            timestamp: target.timestamp, open: target.open, high: target.targetHigh, low: target.targetLow, close: target.targetClose
        });
        currentPrice = target.targetClose;
    }

    markets[marketId] = {
        marketId, marketPath: path, history: candles, currentPrice: currentPrice
    };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let command = 'NATURAL';
        
        if (marketData.nextCandleCommand) {
            command = marketData.nextCandleCommand;
            console.log(`[ADMIN COMMAND] Executing ${command} for ${marketData.marketId}`);
            marketData.nextCandleCommand = null; 
        } 
        else {
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    command = adminPattern.pattern[patternIndex];
                }
            }
        }
        
        const newCandle = generateCandleTargets(currentPeriod, lastCandle.close, command);
        // Reset currentPrice to open smoothly
        marketData.currentPrice = newCandle.open;
        
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// 🔥 V26: Ultra Smooth Gliding Animation (No More Jitter/Jumping) 🔥
function updateRealisticPrice(marketData, candle, currentPeriod) {
    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    const { pattern, isGreen, targetHigh, targetLow, targetClose, open } = candle;
    let targetPoint = open;

    // 1. Determine where the price should smoothly glide towards based on time
    if (pattern === 'NORMAL') {
        if (isGreen) {
            if (progress < 0.3) targetPoint = targetLow; // Glide down to form bottom wick
            else if (progress < 0.7) targetPoint = targetHigh; // Glide up to form top wick
            else targetPoint = targetClose; // Settle down to close
        } else {
            if (progress < 0.3) targetPoint = targetHigh; // Glide up to form top wick
            else if (progress < 0.7) targetPoint = targetLow; // Glide down to form bottom wick
            else targetPoint = targetClose; // Settle up to close
        }
    } 
    else if (pattern === 'HAMMER') {
        if (progress < 0.4) targetPoint = targetLow;
        else targetPoint = targetClose;
    } 
    else if (pattern === 'SHOOTING_STAR') {
        if (progress < 0.4) targetPoint = targetHigh;
        else targetPoint = targetClose;
    } 
    else if (pattern === 'DOJI') {
        if (progress < 0.3) targetPoint = targetHigh;
        else if (progress < 0.7) targetPoint = targetLow;
        else targetPoint = targetClose;
    } 
    else if (pattern === 'MARUBOZU') {
        targetPoint = targetClose; // Straight glide to close
    }

    // 2. Smoothly Interpolate (Lerp) current price towards the target point
    const distanceToTarget = targetPoint - (marketData.currentPrice || open);
    
    // Easing factor (0.05 is very smooth and slow, exactly like real markets)
    const easing = 0.06; 
    
    // Micro-noise so it breathes naturally like a real tick chart
    const noise = (Math.random() - 0.5) * (open * 0.000003); 

    marketData.currentPrice = (marketData.currentPrice || open) + (distanceToTarget * easing) + noise;

    // Final Snap to exactly hit the Close price at the end of the minute
    if (timeElapsed >= TIMEFRAME - 1000) {
        marketData.currentPrice = targetClose;
    }

    candle.close = roundPrice(marketData.currentPrice);
    
    // Dynamically expand high and low as the minute progresses
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

// Listeners & Express Endpoints
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

// Main Animation Loop
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
        console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up.`);
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V26 - Low Volatility & Smooth Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---