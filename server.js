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

// 1. INSTANT HISTORICAL CANDLE (For loading past data fast)
function generateInstantHistoricalCandle(timestamp, open) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    // Normal realistic sizes for history
    const body = (0.00004 + Math.random() * 0.00015) * safeOpen; 
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (Math.random() * 0.0001) * safeOpen;
    const lowerWick = (Math.random() * 0.0001) * safeOpen;

    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(Math.max(safeOpen, close) + upperWick),
        low: roundPrice(Math.min(safeOpen, close) - lowerWick),
        close: roundPrice(close)
    };
}

// 2. LIVE NATURAL CANDLE (Starts empty, grows via Random Walk)
function generateNaturalLiveCandle(timestamp, open) {
    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(open),
        low: roundPrice(open),
        close: roundPrice(open),
        isPredetermined: false // Indicates True Random Walk Mode
    };
}

// 3. ADMIN CONTROLLED CANDLE (Has strict targets to form a shape)
function generateAdminCandle(timestamp, open, command) {
    const baseVol = open * (0.0001 + Math.random() * 0.0001);
    let isGreen, bodySize, upperWick, lowerWick, patternType;

    switch (command) {
        case 'GREEN':
            bodySize = baseVol; upperWick = baseVol * Math.random(); lowerWick = baseVol * Math.random(); isGreen = true; patternType = 'NORMAL'; break;
        case 'RED':
            bodySize = baseVol; upperWick = baseVol * Math.random(); lowerWick = baseVol * Math.random(); isGreen = false; patternType = 'NORMAL'; break;
        case 'BULLISH_MARUBOZU':
            bodySize = baseVol * 2.0; upperWick = 0; lowerWick = 0; isGreen = true; patternType = 'MARUBOZU'; break;
        case 'BEARISH_MARUBOZU':
            bodySize = baseVol * 2.0; upperWick = 0; lowerWick = 0; isGreen = false; patternType = 'MARUBOZU'; break;
        case 'GREEN_HAMMER':
            bodySize = baseVol * 0.3; upperWick = baseVol * 0.1; lowerWick = baseVol * 1.8; isGreen = true; patternType = 'HAMMER'; break;
        case 'RED_HAMMER':
            bodySize = baseVol * 0.3; upperWick = baseVol * 0.1; lowerWick = baseVol * 1.8; isGreen = false; patternType = 'HAMMER'; break;
        case 'GREEN_SHOOTING_STAR':
            bodySize = baseVol * 0.3; upperWick = baseVol * 1.8; lowerWick = baseVol * 0.1; isGreen = true; patternType = 'SHOOTING_STAR'; break;
        case 'RED_SHOOTING_STAR':
            bodySize = baseVol * 0.3; upperWick = baseVol * 1.8; lowerWick = baseVol * 0.1; isGreen = false; patternType = 'SHOOTING_STAR'; break;
        case 'DOJI':
            bodySize = baseVol * 0.02; upperWick = baseVol * 1.2; lowerWick = baseVol * 1.2; isGreen = Math.random() > 0.5; patternType = 'DOJI'; break;
        default:
            bodySize = baseVol; upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5; isGreen = true; patternType = 'NORMAL';
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
        isPredetermined: true, // Indicates Admin Command Mode
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
        const c = generateInstantHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId, marketPath: path, history: candles, currentPrice: currentPrice, lastMove: 0
    };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        // Check for Admin Command
        if (marketData.nextCandleCommand) {
            newCandle = generateAdminCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            console.log(`[ADMIN] Executing ${marketData.nextCandleCommand} for ${marketData.marketId}`);
            marketData.nextCandleCommand = null; 
        } 
        else {
            // Check for Firebase Pattern
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    newCandle = generateAdminCandle(currentPeriod, lastCandle.close, adminPattern.pattern[patternIndex]);
                }
            }
        }

        // If no admin command, generate a Natural Random Walk candle
        if (!newCandle) {
            newCandle = generateNaturalLiveCandle(currentPeriod, lastCandle.close);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// 🔥 The Tick Engine (Handles both Random Walk and Admin Paths) 🔥
function updateRealisticPrice(marketData, candle, currentPeriod) {
    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    if (candle.isPredetermined) {
        // ==========================================
        // ADMIN MODE: Forced Pathing to Shape
        // ==========================================
        let idealPrice = candle.open;
        const { pattern, isGreen, targetHigh, targetLow, targetClose, open } = candle;

        if (pattern === 'HAMMER') {
            if (progress < 0.4) idealPrice = open + (targetLow - open) * (progress / 0.4); 
            else idealPrice = targetLow + (targetClose - targetLow) * ((progress - 0.4) / 0.6); 
        } 
        else if (pattern === 'SHOOTING_STAR') {
            if (progress < 0.4) idealPrice = open + (targetHigh - open) * (progress / 0.4); 
            else idealPrice = targetHigh + (targetClose - targetHigh) * ((progress - 0.4) / 0.6); 
        } 
        else if (pattern === 'DOJI') {
            if (progress < 0.3) idealPrice = open + (targetHigh - open) * (progress / 0.3); 
            else if (progress < 0.7) idealPrice = targetHigh + (targetLow - targetHigh) * ((progress - 0.3) / 0.4); 
            else idealPrice = targetLow + (targetClose - targetLow) * ((progress - 0.7) / 0.3); 
        } 
        else if (pattern === 'MARUBOZU') {
            idealPrice = open + (targetClose - open) * progress; 
        } 
        else { // NORMAL
            if (isGreen) {
                if (progress < 0.2) idealPrice = open + (targetLow - open) * (progress / 0.2); 
                else if (progress < 0.8) idealPrice = targetLow + (targetHigh - targetLow) * ((progress - 0.2) / 0.6); 
                else idealPrice = targetHigh + (targetClose - targetHigh) * ((progress - 0.8) / 0.2); 
            } else {
                if (progress < 0.2) idealPrice = open + (targetHigh - open) * (progress / 0.2); 
                else if (progress < 0.8) idealPrice = targetHigh + (targetLow - targetHigh) * ((progress - 0.2) / 0.6); 
                else idealPrice = targetLow + (targetClose - targetLow) * ((progress - 0.8) / 0.2); 
            }
        }

        const noiseFactor = Math.sin(progress * Math.PI); 
        const noise = (Math.random() - 0.5) * (open * 0.0001) * noiseFactor;
        marketData.currentPrice = idealPrice + noise;

        marketData.currentPrice = Math.min(marketData.currentPrice, targetHigh);
        marketData.currentPrice = Math.max(marketData.currentPrice, targetLow);

        if (timeElapsed >= TIMEFRAME - 1000) {
            marketData.currentPrice = targetClose;
        }
    } 
    else {
        // ==========================================
        // NATURAL MODE: True Random Walk (Like Binance)
        // ==========================================
        const openPrice = candle.open;
        const baseVolatility = openPrice * 0.00004;

        // Calculate random impulse and mean-reversion recoil
        let impulse = (Math.random() - 0.5) * baseVolatility * 2.0;
        let recoil = -(marketData.lastMove || 0) * 0.25; 
        let jitter = (Math.random() - 0.5) * (baseVolatility * 0.5);
        
        let finalMove = impulse + recoil + jitter;
        
        // Occasional volume spike
        if (Math.random() < 0.05) finalMove *= 3.5; 

        marketData.currentPrice += finalMove;
        marketData.lastMove = finalMove;

        // Soft limit to prevent 1-minute candles from becoming impossibly huge naturally
        const dist = marketData.currentPrice - openPrice;
        if (Math.abs(dist) > openPrice * 0.001) {
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

app.get('/ping', (_req, res) => res.send('UltraSmooth V25 - True Random Walk Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));