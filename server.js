// --- START: server.js (V22 - Smart Admin Control) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// Firebase Config
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

// CONFIG
const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const adminDataMap = {}; // 🔥 full admin data store

// ---------------- HELPERS ----------------
function roundPrice(v) {
    return parseFloat(Math.max(MIN_PRICE, v).toFixed(5));
}

function marketPathFromId(id) {
    return String(id || '').replace(/[\.\/ ]/g, '-').toLowerCase();
}

// ---------------- ADMIN LISTENER ----------------
db.ref('admin/markets').on('value', (snap) => {
    const data = snap.val() || {};
    Object.keys(data).forEach(id => {
        adminDataMap[id] = data[id]; // 🔥 FULL CONTROL
    });
});

// ---------------- CANDLE GENERATORS ----------------
function generateHistoricalCandle(timestamp, open) {
    const isGreen = Math.random() > 0.5;
    const move = open * (0.0001 + Math.random() * 0.0002);
    const close = isGreen ? open + move : open - move;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(Math.max(open, close) + move * 0.5),
        low: roundPrice(Math.min(open, close) - move * 0.5),
        close: roundPrice(close)
    };
}

function generateAdminCandle(timestamp, open, color) {
    const move = open * (0.00015 + Math.random() * 0.0001);
    const close = color === "GREEN" ? open + move : open - move;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(Math.max(open, close) + move * 0.4),
        low: roundPrice(Math.min(open, close) - move * 0.4),
        close: roundPrice(close)
    };
}

// 🔥 SMART MARKET
function getVolatility(level) {
    if (level === "LOW") return 0.5;
    if (level === "HIGH") return 2;
    return 1;
}

function getTrendBias(trend) {
    if (trend === "UP") return 1;
    if (trend === "DOWN") return -1;
    return 0;
}

function generateSmartCandle(timestamp, open, control) {
    const vol = getVolatility(control.volatility);
    const trend = getTrendBias(control.trend);

    let dir = Math.random() > 0.5 ? 1 : -1;
    dir += trend * 0.7;

    dir = dir > 0 ? 1 : -1;

    const move = open * (0.0001 * vol) * (1 + Math.random());
    const close = open + (move * dir);

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(Math.max(open, close) + move * 0.3),
        low: roundPrice(Math.min(open, close) - move * 0.3),
        close: roundPrice(close)
    };
}

// ---------------- MARKET INIT ----------------
async function initializeNewMarket(id) {
    const path = marketPathFromId(id);
    let price = 1.15;

    try {
        const snap = await db.ref(`markets/${path}/live`).once('value');
        if (snap.val()?.price) price = snap.val().price;
    } catch {}

    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    let candles = [];
    let current = price;

    for (let i = 300; i > 0; i--) {
        const c = generateHistoricalCandle(now - i * TIMEFRAME, current);
        candles.push(c);
        current = c.close;
    }

    markets[id] = {
        marketId: id,
        marketPath: path,
        history: candles,
        currentPrice: current,
        lastMove: 0
    };
}

// ---------------- MAIN CANDLE LOGIC ----------------
function ensureCurrentPeriodCandle(market, currentPeriod) {
    let last = market.history[market.history.length - 1];
    if (!last) return null;

    if (currentPeriod > last.timestamp) {

        let newCandle;
        const admin = adminDataMap[market.marketId] || {};

        const pattern = admin.pattern_config;
        const manual = admin.manual;
        const control = admin.market_control || {
            trend: "AUTO",
            volatility: "MEDIUM"
        };

        // 🎮 MANUAL
        if (manual?.isActive && manual?.nextCandle) {
            newCandle = generateAdminCandle(currentPeriod, last.close, manual.nextCandle);
            manual.nextCandle = null;
            console.log(`[MANUAL] ${market.marketId} → ${manual.nextCandle}`);
        }

        // 🎯 PATTERN
        else if (pattern?.isActive && currentPeriod >= pattern.startTime) {
            const i = Math.floor((currentPeriod - pattern.startTime) / TIMEFRAME);
            if (pattern.pattern[i]) {
                newCandle = generateAdminCandle(currentPeriod, last.close, pattern.pattern[i]);
                console.log(`[PATTERN] ${market.marketId} → ${pattern.pattern[i]}`);
            }
        }

        // 🤖 SMART
        if (!newCandle) {
            newCandle = generateSmartCandle(currentPeriod, last.close, control);
        }

        market.history.push(newCandle);
        if (market.history.length > MAX_CANDLES) market.history.shift();

        return newCandle;
    }

    return last;
}

// ---------------- PRICE UPDATE ----------------
function updateRealisticPrice(market, candle) {
    if (Math.random() < 0.4) return;

    const move = (Math.random() - 0.5) * candle.open * 0.00005;
    market.currentPrice += move;

    candle.close = roundPrice(market.currentPrice);
    candle.high = Math.max(candle.high, candle.close);
    candle.low = Math.min(candle.low, candle.close);
}

// ---------------- WS ----------------
function broadcast(marketId, candle) {
    const data = JSON.stringify({ market: marketId, candle });

    wss.clients.forEach(c => {
        if (c.readyState === 1 && c.subscribedMarket === marketId) {
            c.send(data);
        }
    });
}

wss.on('connection', ws => {
    ws.on('message', msg => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'subscribe') {
                ws.subscribedMarket = data.market;

                if (markets[data.market]) {
                    ws.send(JSON.stringify({
                        type: 'history',
                        candles: markets[data.market].history.slice(-300)
                    }));
                }
            }
        } catch {}
    });
});

// ---------------- MARKET INIT LISTENER ----------------
db.ref('admin/markets').on('value', snap => {
    const data = snap.val() || {};
    Object.keys(data).forEach(id => {
        if (!markets[id]) initializeNewMarket(id);
    });
});

// ---------------- LOOP ----------------
setInterval(() => {
    const now = Date.now();
    const current = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (let id in markets) {
        const m = markets[id];
        let candle = ensureCurrentPeriodCandle(m, current);
        if (!candle) continue;

        updateRealisticPrice(m, candle);
        broadcast(id, candle);
    }

}, TICK_MS);

// ---------------- START ----------------
app.get('/ping', (_, res) => res.send("V22 Smart Server Running"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server Running on", PORT));

// --- END ---