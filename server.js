// --- START OF FILE server.js ---
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// ==========================================
// 1. MAIN FIREBASE (For Users & Market Status)
// ==========================================
const mainConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade"
};
const mainApp = firebase.initializeApp(mainConfig, "mainApp");
const mainDb = mainApp.database();

// ==========================================
// 2. ADMIN COMMAND FIREBASE (The New One)
// ==========================================
const adminConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1"
};
const adminApp = firebase.initializeApp(adminConfig, "adminApp");
const adminDb = adminApp.database();

// ==========================================
// SERVER SETUP
// ==========================================
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TIMEFRAME = 60000; 
const TICK_MS = 300; 
const MAX_HISTORY = 150;

const markets = {}; 
const activeCommands = {}; 

function roundPrice(v) { return parseFloat(v.toFixed(5)); }

// Listen for active markets from Main Firebase
mainDb.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        if (fbMarkets[marketId].status === 'active' && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// Listen for Admin Pattern Commands from Admin Firebase
adminDb.ref('commands').on('value', (snapshot) => {
    const commands = snapshot.val() || {};
    Object.keys(commands).forEach(marketId => {
        const incomingCmd = commands[marketId];
        if (!activeCommands[marketId] || activeCommands[marketId].timestamp !== incomingCmd.timestamp) {
            console.log(`📝 [ADMIN] New sequence received for ${marketId}: [${incomingCmd.pattern.join(', ')}]`);
            activeCommands[marketId] = {
                pattern: incomingCmd.pattern,
                currentIndex: 0,
                timestamp: incomingCmd.timestamp
            };
        }
    });
});

function initializeNewMarket(marketId) {
    const history = [];
    let currentPrice = 1.15500;
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    
    for (let i = 60; i > 0; i--) {
        const c = buildCandle(nowPeriod - (i * TIMEFRAME), currentPrice, 'RANDOM');
        history.push(c);
        currentPrice = c.close;
    }
    markets[marketId] = { 
        marketPath: String(marketId).replace(/[\.\/ ]/g, '-').toLowerCase(),
        history, 
        currentPrice,
        lockedForNext: false, 
        nextCandleType: 'RANDOM' 
    };
}

// 🎨 ADVANCED CANDLESTICK PATTERN GENERATOR 🎨
function buildCandle(timestamp, open, type) {
    const volatility = open * 0.0004;
    let bodySize = volatility * (0.3 + Math.random() * 0.5);
    let upperWick = volatility * Math.random() * 0.5;
    let lowerWick = volatility * Math.random() * 0.5;
    let direction = Math.random() > 0.5 ? 'UP' : 'DOWN';
    let isForced = type !== 'RANDOM';

    if (isForced) {
        switch(type) {
            case "UP": direction = 'UP'; upperWick = 0; lowerWick = 0; break;
            case "DOWN": direction = 'DOWN'; upperWick = 0; lowerWick = 0; break;
            case "DOJI": bodySize = volatility * 0.02; upperWick = volatility; lowerWick = volatility; break;
            case "HAMMER": bodySize = volatility * 0.3; upperWick = volatility * 0.1; lowerWick = volatility * 1.5; direction = 'UP'; break;
            case "SHOOTING_STAR": bodySize = volatility * 0.3; upperWick = volatility * 1.5; lowerWick = volatility * 0.1; direction = 'DOWN'; break;
            case "BULLISH_ENGULFING": bodySize = volatility * 1.8; upperWick = volatility * 0.1; lowerWick = volatility * 0.1; direction = 'UP'; break;
            case "BEARISH_ENGULFING": bodySize = volatility * 1.8; upperWick = volatility * 0.1; lowerWick = volatility * 0.1; direction = 'DOWN'; break;
            case "MARUBOZU_GREEN": bodySize = volatility * 2; upperWick = 0; lowerWick = 0; direction = 'UP'; break;
            case "MARUBOZU_RED": bodySize = volatility * 2; upperWick = 0; lowerWick = 0; direction = 'DOWN'; break;
        }
    }

    let close, high, low;
    if (direction === 'UP') {
        close = open + bodySize;
        high = close + upperWick;
        low = isForced && (type==='UP' || type==='MARUBOZU_GREEN' || type==='BULLISH_ENGULFING') ? open : open - lowerWick;
    } else {
        close = open - bodySize;
        high = isForced && (type==='DOWN' || type==='MARUBOZU_RED' || type==='BEARISH_ENGULFING') ? open : open + upperWick;
        low = close - lowerWick;
    }
    return { timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close), isForced, patternType: type };
}

// ⚙️ THE MAIN ENGINE (Runs every 300ms) ⚙️
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const timeIntoCandle = now - currentPeriod;

    for (const marketId in markets) {
        const m = markets[marketId];
        let lastCandle = m.history[m.history.length - 1];
        if (!lastCandle) continue;

        // 🔥 1. CHECK ADMIN COMMAND AT THE LAST 30 SECONDS 🔥
        if (timeIntoCandle >= 30000 && !m.lockedForNext) {
            const cmd = activeCommands[marketId];
            if (cmd && cmd.currentIndex < cmd.pattern.length) {
                m.nextCandleType = cmd.pattern[cmd.currentIndex];
                cmd.currentIndex++;
                console.log(`🔒 [LOCKED] Next candle for ${marketId} will be: ${m.nextCandleType}`);
            } else {
                m.nextCandleType = 'RANDOM';
            }
            m.lockedForNext = true; 
        }

        // 🔥 2. ROLLOVER: GENERATE THE NEW CANDLE 🔥
        if (currentPeriod > lastCandle.timestamp) {
            const newCandle = buildCandle(currentPeriod, lastCandle.close, m.nextCandleType);
            m.history.push(newCandle);
            if (m.history.length > MAX_HISTORY) m.history.shift();
            lastCandle = newCandle;
            
            m.lockedForNext = false;
            m.nextCandleType = 'RANDOM';

            const cmd = activeCommands[marketId];
            if (cmd && cmd.currentIndex >= cmd.pattern.length) {
                console.log(`✅ [FINISHED] Sequence for ${marketId} completed. Reverting to Auto.`);
                delete activeCommands[marketId];
                adminDb.ref(`commands/${marketId}`).remove(); 
            }
        }

        // 🔥 3. LIVE TICK SIMULATION 🔥
        const progress = Math.min(timeIntoCandle / TIMEFRAME, 1);
        let livePrice;

        if (lastCandle.isForced) {
            // Straight movement for forced candles (No reverse wicks)
            livePrice = lastCandle.open + (lastCandle.close - lastCandle.open) * progress;
        } else {
            // Realistic movement for random candles
            if (progress < 0.33) {
                const wickTarget = lastCandle.close >= lastCandle.open ? lastCandle.low : lastCandle.high;
                livePrice = lastCandle.open + (wickTarget - lastCandle.open) * (progress / 0.33);
            } else if (progress < 0.66) {
                const wickStart = lastCandle.close >= lastCandle.open ? lastCandle.low : lastCandle.high;
                const wickTarget = lastCandle.close >= lastCandle.open ? lastCandle.high : lastCandle.low;
                livePrice = wickStart + (wickTarget - wickStart) * ((progress - 0.33) / 0.33);
            } else {
                const wickStart = lastCandle.close >= lastCandle.open ? lastCandle.high : lastCandle.low;
                livePrice = wickStart + (lastCandle.close - wickStart) * ((progress - 0.66) / 0.34);
            }
        }

        livePrice += (Math.random() - 0.5) * (lastCandle.open * 0.00003); // tiny noise
        m.currentPrice = Math.max(lastCandle.low, Math.min(lastCandle.high, livePrice));
        m.currentPrice = roundPrice(m.currentPrice);

        const liveCandleData = {
            ...lastCandle,
            close: m.currentPrice // Client sees this as the live moving price
        };
        
        const payload = JSON.stringify({ type: 'subscribed', market: marketId, candle: liveCandleData });
        wss.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN && c.subscribedMarket === marketId) c.send(payload);
        });
    }
}, TICK_MS);

app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId]) res.json(markets[marketId].history);
    else res.status(404).json({ error: 'Market not found' });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe') ws.subscribedMarket = msg.market;
        } catch (_) {}
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Master Engine (Dual-Firebase) running on port ${PORT}`));
// --- END OF FILE ---