// --- START OF FILE server.js ---
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
    projectId: "ictex-trade"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TIMEFRAME = 60000; 
const TICK_MS = 300; // Send updates frequently for smooth chart
const MAX_HISTORY = 300;

const markets = {}; 
const adminSignals = {}; 

function roundPrice(v) { return parseFloat(v.toFixed(5)); }

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        if (fbMarkets[marketId].status === 'active' && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

db.ref('admin/market_signals').on('value', (snapshot) => {
    Object.assign(adminSignals, snapshot.val() || {});
});

function initializeNewMarket(marketId) {
    const history = [];
    let currentPrice = 1.15500;
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    
    for (let i = MAX_HISTORY; i > 0; i--) {
        const c = buildCandle(nowPeriod - (i * TIMEFRAME), currentPrice, Math.random() > 0.5 ? 'UP' : 'DOWN');
        history.push(c);
        currentPrice = c.close;
    }
    markets[marketId] = { history, currentPrice };
}

function buildCandle(timestamp, open, direction) {
    const volatility = open * 0.0004;
    const bodySize = volatility * (0.5 + Math.random());
    
    let close, high, low;
    if (direction === 'UP') {
        close = open + bodySize;
        high = close + (volatility * Math.random() * 0.5);
        low = open - (volatility * Math.random() * 0.3);
    } else {
        close = open - bodySize;
        high = open + (volatility * Math.random() * 0.3);
        low = close - (volatility * Math.random() * 0.5);
    }
    return { timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };
}

// Main processing loop
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (const marketId in markets) {
        const m = markets[marketId];
        let lastCandle = m.history[m.history.length - 1];

        // Time to create a new, finalized candle
        if (!lastCandle || currentPeriod > lastCandle.timestamp) {
            const signal = adminSignals[marketId];
            let direction = Math.random() > 0.5 ? 'UP' : 'DOWN';

            if (signal && (signal.type === 'UP' || signal.type === 'DOWN')) {
                console.log(`[ADMIN] Executing ${signal.type} for ${marketId}`);
                direction = signal.type;
                db.ref(`admin/market_signals/${marketId}`).remove();
                delete adminSignals[marketId];
            }
            
            const newCandle = buildCandle(currentPeriod, lastCandle.close, direction);
            m.history.push(newCandle);
            if (m.history.length > MAX_HISTORY) m.history.shift();
            lastCandle = newCandle;
        }

        // Live tick simulation
        const timeIntoCandle = now - lastCandle.timestamp;
        const progress = Math.min(timeIntoCandle / TIMEFRAME, 1);
        
        // Move current price towards the final close price over 1 minute
        let livePrice = lastCandle.open + (lastCandle.close - lastCandle.open) * progress;
        livePrice += (Math.random() - 0.5) * (lastCandle.open * 0.00005); // Add jitter
        m.currentPrice = roundPrice(livePrice);

        // Update the live candle object for broadcasting
        const liveCandleData = {
            timestamp: lastCandle.timestamp,
            open: lastCandle.open,
            high: Math.max(lastCandle.high, m.currentPrice),
            low: Math.min(lastCandle.low, m.currentPrice),
            close: m.currentPrice,
        };
        
        const payload = JSON.stringify({ type: 'subscribed', market: marketId, candle: liveCandleData });

        wss.clients.forEach((c) => {
            if (c.readyState === WebSocket.OPEN && c.subscribedMarket === marketId) {
                c.send(payload);
            }
        });
    }
}, TICK_MS);

// API to serve initial history
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId]) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 TradingView-Compatible Server running on port ${PORT}`));