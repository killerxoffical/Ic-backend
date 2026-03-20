const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

const firebaseConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000;
const TICK_MS = 200;
const TARGET_RESET_TICKS = 10;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const adminOverrides = {};
const adminPatterns = {};

function roundPrice(value) {
    return parseFloat(Math.max(MIN_PRICE, value).toFixed(5));
}

function cloneCandle(candle) {
    return {
        timestamp: candle.timestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close
    };
}

function generateHistoricalCandle(timestamp, open) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    const body = (Math.random() * 0.0004) * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (Math.random() * 0.0002) * safeOpen;
    const lowerWick = (Math.random() * 0.0002) * safeOpen;

    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(Math.max(safeOpen, close) + upperWick),
        low: roundPrice(Math.min(safeOpen, close) - lowerWick),
        close: roundPrice(close)
    };
}

function getRandomExistingClose() {
    const ids = Object.keys(markets);
    if (!ids.length) return null;
    const randomId = ids[Math.floor(Math.random() * ids.length)];
    const last = markets[randomId]?.history?.[markets[randomId].history.length - 1];
    return last?.close ?? null;
}

function initializeNewMarket(marketId, fbMarket = {}) {
    console.log(`Initializing market: ${fbMarket.name || marketId} (${marketId})`);

    let startPrice = getRandomExistingClose() ?? (1.15000 + (Math.random() - 0.5) * 0.1);
    let currentPrice = Math.max(MIN_PRICE, startPrice);
    const candles = [];
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const candle = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
        candles.push(candle);
        currentPrice = candle.close;
    }

    markets[marketId] = {
        history: candles,
        currentPrice,
        targetPrice: currentPrice,
        tickCount: 0,
        lastPeriod: candles[candles.length - 1]?.timestamp ?? nowPeriod
    };
}

function getCurrentForceDirection(marketId, currentPeriod) {
    const override = adminOverrides[marketId];
    if (override && override.timestamp > Date.now() - 60000) {
        return override.type;
    }

    const patternConfig = adminPatterns[marketId];
    if (patternConfig && patternConfig.isActive) {
        const index = Math.floor((currentPeriod - patternConfig.startTime) / (patternConfig.timeframe * 1000));
        if (index >= 0 && index < patternConfig.pattern.length) {
            return patternConfig.pattern[index];
        }
    }

    return null;
}

function createFlatCurrentCandle(timestamp, price) {
    const safe = roundPrice(price);
    return { timestamp, open: safe, high: safe, low: safe, close: safe };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) {
        const fallback = createFlatCurrentCandle(currentPeriod, marketData.currentPrice || 1.15);
        marketData.history.push(fallback);
        marketData.currentPrice = fallback.close;
        marketData.targetPrice = fallback.close;
        return fallback;
    }

    const timeDiff = currentPeriod - lastCandle.timestamp;
    if (timeDiff < TIMEFRAME) return lastCandle;

    const missingCount = Math.floor(timeDiff / TIMEFRAME);
    let currentGenTime = lastCandle.timestamp;

    for (let i = 0; i < missingCount; i++) {
        currentGenTime += TIMEFRAME;
        let newCandle;
        if (currentGenTime < currentPeriod) {
            newCandle = generateHistoricalCandle(currentGenTime, lastCandle.close);
        } else {
            newCandle = createFlatCurrentCandle(currentGenTime, lastCandle.close);
        }
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        lastCandle = newCandle;
    }

    marketData.currentPrice = lastCandle.close;
    marketData.targetPrice = lastCandle.close;
    marketData.tickCount = TARGET_RESET_TICKS;
    marketData.lastPeriod = lastCandle.timestamp;
    return lastCandle;
}

function computeTargetPrice(marketId, marketData, lastCandle, currentPeriod) {
    const forceDir = getCurrentForceDirection(marketId, currentPeriod);
    const baseVolatility = Math.max(lastCandle.open * 0.00015, 0.00001);

    if (forceDir && forceDir.startsWith('PATTERN_CUSTOM_')) {
        const parts = forceDir.split('_');
        const body = parseInt(parts[4], 10) || 40;
        const totalScale = lastCandle.open * 0.0009;
        return parts[2] === 'GREEN'
            ? lastCandle.open + (totalScale * (body / 100))
            : lastCandle.open - (totalScale * (body / 100));
    }

    if (['UP', 'GREEN'].includes(forceDir)) {
        return marketData.currentPrice + (Math.random() * baseVolatility * 1.5) - (baseVolatility * 0.2);
    }

    if (['DOWN', 'RED'].includes(forceDir)) {
        return marketData.currentPrice - (Math.random() * baseVolatility * 1.5) + (baseVolatility * 0.2);
    }

    const randomMove = (Math.random() - 0.5) * baseVolatility * 2.2;
    const distanceToOpen = marketData.currentPrice - lastCandle.open;
    const meanReversion = -distanceToOpen * 0.10;
    return marketData.currentPrice + randomMove + meanReversion;
}

function updateLiveCandle(marketId, marketData, currentPeriod) {
    let lastCandle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!lastCandle) return null;

    if (!marketData.tickCount) marketData.tickCount = 0;
    marketData.tickCount += 1;

    if (marketData.tickCount >= TARGET_RESET_TICKS || !Number.isFinite(marketData.targetPrice)) {
        marketData.tickCount = 0;
        marketData.targetPrice = computeTargetPrice(marketId, marketData, lastCandle, currentPeriod);
    }

    const distance = marketData.targetPrice - marketData.currentPrice;
    let step = distance * 0.15;

    if (Math.abs(step) < 0.000001) {
        step = distance === 0 ? 0 : (distance > 0 ? 0.000001 : -0.000001);
    }

    marketData.currentPrice = Math.max(MIN_PRICE, marketData.currentPrice + step);
    const jitter = (Math.random() - 0.5) * 0.000008 * Math.max(lastCandle.open, MIN_PRICE);
    const nextClose = roundPrice(marketData.currentPrice + jitter);

    lastCandle.close = nextClose;
    lastCandle.high = roundPrice(Math.max(lastCandle.high, nextClose));
    lastCandle.low = roundPrice(Math.min(lastCandle.low, nextClose));
    marketData.currentPrice = nextClose;
    marketData.lastPeriod = lastCandle.timestamp;

    return lastCandle;
}

function shouldSendToClient(client, marketId) {
    if (!client.subscribedMarket) return true;
    return client.subscribedMarket === marketId;
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({
        market: marketId,
        candle,
        serverTime: Date.now(),
        timeframe: TIMEFRAME
    });

    wss.clients.forEach((client) => {
        if (client.readyState !== WebSocket.OPEN) return;
        if (!shouldSendToClient(client, marketId)) return;
        client.send(payload);
    });
}

const adminMarketsRef = db.ref('admin/markets');
adminMarketsRef.on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};

    Object.keys(fbMarkets).forEach((marketId) => {
        if (fbMarkets[marketId]?.type === 'otc' && !markets[marketId]) {
            initializeNewMarket(marketId, fbMarkets[marketId]);
        }
    });

    Object.keys(markets).forEach((marketId) => {
        if (!fbMarkets[marketId] || fbMarkets[marketId].type !== 'otc') {
            delete markets[marketId];
            delete adminOverrides[marketId];
            delete adminPatterns[marketId];
        }
    });
});

db.ref('admin/market_overrides').on('value', (snap) => {
    const next = snap.val() || {};
    Object.keys(adminOverrides).forEach((key) => {
        if (!(key in next)) delete adminOverrides[key];
    });
    Object.assign(adminOverrides, next);
});

db.ref('admin/markets').on('value', (snap) => {
    const data = snap.val() || {};
    Object.keys(adminPatterns).forEach((key) => {
        if (!data[key]?.pattern_config) delete adminPatterns[key];
    });
    Object.keys(data).forEach((id) => {
        if (data[id]?.pattern_config) adminPatterns[id] = data[id].pattern_config;
    });
});

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.subscribedMarket = null;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());

            if (msg?.type === 'subscribe' && typeof msg.market === 'string') {
                ws.subscribedMarket = msg.market;

                const marketData = markets[msg.market];
                const latest = marketData?.history?.[marketData.history.length - 1];

                if (latest && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'subscribed',
                        market: msg.market,
                        candle: latest,
                        serverTime: Date.now(),
                        timeframe: TIMEFRAME
                    }));
                }
            }
        } catch (err) {
            // old client হলে ignore
        }
    });
});

const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }

        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

setInterval(() => {
    const currentPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach((marketId) => {
        const marketData = markets[marketId];
        if (!marketData?.history?.length) return;

        const candle = updateLiveCandle(marketId, marketData, currentPeriod);
        if (!candle) return;

        broadcastCandle(marketId, cloneCandle(candle));
    });
}, TICK_MS);

app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    const marketData = markets[marketId];

    if (!marketData?.history?.length) {
        res.status(404).json([]);
        return;
    }

    res.json(marketData.history.map(cloneCandle));
});

app.get('/ping', (req, res) => {
    res.send('UltraSmooth V8 - Stable Sync Engine');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Ultra Smooth Server v8 on ${PORT}`);
});

server.on('close', () => clearInterval(heartbeat));