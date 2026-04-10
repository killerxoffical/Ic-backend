// --- START: server.js (WebSocket Chart & Perfect Timing V9) ---

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

// 🔥 CORE LOGIC: PRECISE PATTERN GENERATOR 🔥
function generateTargetPattern(timestamp, openPrice, action) {
    let baseVol = openPrice * 0.00005;
    
    // Default Random Candle
    let body = baseVol * (0.5 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();
    let isGreen = Math.random() > 0.5;

    if (action) {
        // BULLISH PATTERNS (GREEN)
        if (action === 'PATTERN_MARUBOZU_GREEN') {
            isGreen = true; body = baseVol * 4; upWick = 0; dnWick = 0;
        } 
        else if (action === 'PATTERN_HAMMER' || action === 'PATTERN_BULLISH_PINBAR') {
            isGreen = true; body = baseVol * 1.0; upWick = baseVol * 0.2; dnWick = baseVol * 3.5;
        }
        else if (action === 'PATTERN_BULLISH_SPINNING') {
            isGreen = true; body = baseVol * 0.8; upWick = baseVol * 2.0; dnWick = baseVol * 2.0;
        }
        else if (action === 'PATTERN_DRAGONFLY_DOJI') {
            isGreen = true; body = baseVol * 0.05; upWick = 0; dnWick = baseVol * 4.0;
        }

        // BEARISH PATTERNS (RED)
        else if (action === 'PATTERN_MARUBOZU_RED') {
            isGreen = false; body = baseVol * 4; upWick = 0; dnWick = 0;
        }
        else if (action === 'PATTERN_SHOOTING_STAR' || action === 'PATTERN_BEARISH_PINBAR') {
            isGreen = false; body = baseVol * 1.0; upWick = baseVol * 3.5; dnWick = baseVol * 0.2;
        }
        else if (action === 'PATTERN_BEARISH_SPINNING') {
            isGreen = false; body = baseVol * 0.8; upWick = baseVol * 2.0; dnWick = baseVol * 2.0;
        }
        else if (action === 'PATTERN_GRAVESTONE_DOJI') {
            isGreen = false; body = baseVol * 0.05; upWick = baseVol * 4.0; dnWick = 0;
        }

        // NEUTRAL PATTERNS
        else if (action === 'PATTERN_STANDARD_DOJI') {
            isGreen = Math.random() > 0.5; body = baseVol * 0.05; upWick = baseVol * 1.5; dnWick = baseVol * 1.5;
        }
        else if (action === 'PATTERN_LONG_LEGGED_DOJI') {
            isGreen = Math.random() > 0.5; body = baseVol * 0.1; upWick = baseVol * 4.0; dnWick = baseVol * 4.0;
        }
        // ADVANCED MATH COMMANDS
        else if (action.includes('UP_INSIDE') || action.includes('DOWN_INSIDE')) {
            isGreen = action.includes('UP'); body = baseVol * 0.5; upWick = baseVol * 0.2; dnWick = baseVol * 0.2;
        }
        else if (action.includes('UP_BREAKOUT') || action.includes('DOWN_BREAKOUT')) {
            isGreen = action.includes('UP'); body = baseVol * 1.5; upWick = baseVol * 0.3; dnWick = baseVol * 0.3;
        }
        else if (action.includes('UP_2X') || action.includes('DOWN_2X')) {
            isGreen = action.includes('UP'); body = baseVol * 2.5; upWick = baseVol * 0.5; dnWick = baseVol * 0.5;
        }
        else if (action === 'OPPOSITE_BREAKOUT') {
            isGreen = Math.random() > 0.5; body = baseVol * 1.5; // Will flip based on previous in ensureTargetCandle
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    return { timestamp, open: roundPrice(openPrice), close: roundPrice(close), high: roundPrice(high), low: roundPrice(low), color: isGreen ? 'GREEN' : 'RED', pattern: action || 'RANDOM' };
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
        const target = generateTargetPattern(nowPeriod - (i * TIMEFRAME), currentPrice, null);
        candles.push({ timestamp: target.timestamp, open: target.open, high: target.high, low: target.low, close: target.close });
        currentPrice = target.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        targetCandle: null,
        currentNoise: 0,
        activeCommand: null,
        hitHigh: false,
        hitLow: false
    };
}

function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    // Check if the previous minute just ended to save history
    if (marketData.targetCandle && marketData.targetCandle.timestamp !== currentPeriod) {
        if (marketData.activeCommand) {
            const cmd = marketData.activeCommand;
            db.ref(`admin/commands/${cmd.id}`).update({
                status: 'Executed',
                analytics: {
                    resultCandle: { 
                        open: lastCandle.open, high: lastCandle.high, low: lastCandle.low, close: lastCandle.close, 
                        color: lastCandle.close >= lastCandle.open ? 'GREEN' : 'RED',
                        pattern: marketData.targetCandle.pattern
                    },
                    executedAt: Date.now()
                }
            });
            marketData.activeCommand = null;
        }
    }

    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let activeCmd = null;
        for (const cmdId in adminCommands) {
            const cmd = adminCommands[cmdId];
            if (cmd.marketId === marketData.marketId && cmd.targetTime === currentPeriod && cmd.status === 'Pending') {
                activeCmd = cmd;
                break;
            }
        }

        let target = generateTargetPattern(currentPeriod, lastCandle.close, activeCmd?.action);
        
        // Opposite breakout logic correction
        if (activeCmd && activeCmd.action === 'OPPOSITE_BREAKOUT') {
            const prevWasGreen = lastCandle.close >= lastCandle.open;
            const prevBody = Math.abs(lastCandle.close - lastCandle.open);
            const isGreen = !prevWasGreen;
            const body = prevBody * (1.3 + Math.random() * 0.5);
            const close = isGreen ? target.open + body : target.open - body;
            target.close = roundPrice(close);
            target.high = roundPrice(Math.max(target.open, close) + (body * 0.3));
            target.low = roundPrice(Math.min(target.open, close) - (body * 0.3));
            target.color = isGreen ? 'GREEN' : 'RED';
        }
        
        marketData.targetCandle = target;
        marketData.currentNoise = 0; 
        marketData.hitHigh = false;
        marketData.hitLow = false;
        marketData.activeCommand = activeCmd;
        
        if (activeCmd) {
            db.ref(`admin/commands/${activeCmd.id}`).update({ status: 'Running' });
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

    let newPrice = expectedBasePath + marketData.currentNoise;

    if (progress > 0.2 && progress < 0.8) {
        if (!marketData.hitHigh && Math.random() < 0.05) { newPrice = target.high; marketData.hitHigh = true; } 
        else if (!marketData.hitLow && Math.random() < 0.05) { newPrice = target.low; marketData.hitLow = true; }
    }

    if (progress >= 0.98) { newPrice = target.close; }

    marketData.currentPrice = newPrice;

    liveCandle.close = roundPrice(newPrice);
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, newPrice));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, newPrice));
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

    // ONLY SAVE LIVE PRICE FOR BACKUP (NO HEAVY CANDLE STORAGE)
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

app.get('/ping', (_req, res) => res.send('No-Storage WebSocket Engine V9 Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));