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

const MAX_CANDLES = 300; 
const TIMEFRAME = 60000; 
const TICK_MS = 200;
const MIN_PRICE = 0.00001;

const markets = {}; 
let adminCommands = {}; 
let activeTradesData = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

db.ref('admin/commands').on('value', (snapshot) => { adminCommands = snapshot.val() || {}; });

db.ref('admin/markets').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    activeTradesData = {};
    Object.keys(data).forEach(marketId => {
        activeTradesData[marketId] = data[marketId].activeTrades || {};
    });
});

app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId]) res.json(markets[marketId].history);
    else res.json([]);
});

// 🔥 PRECISE POINT & AUTO LOGIC GENERATOR 🔥
function generateTargetCandle(timestamp, openPrice, marketId, actionStr) {
    let targetClose;
    
    // Check for Admin Point command
    if (actionStr && !isNaN(parseInt(actionStr))) {
        const points = parseInt(actionStr); // This correctly gets -50 or +36
        const pointValue = points * 0.00001;
        targetClose = openPrice + pointValue;
    } 
    // AUTO LOGIC for Users
    else {
        let upVolume = 0;
        let dnVolume = 0;
        const trades = activeTradesData[marketId] || {};
        
        Object.values(trades).forEach(trade => {
            // Only consider trades for the current candle cycle
            if (trade.entryTimestamp >= timestamp && trade.entryTimestamp < (timestamp + 60000)) {
                if (trade.direction === 'UP') upVolume += parseFloat(trade.amount);
                if (trade.direction === 'DOWN') dnVolume += parseFloat(trade.amount);
            }
        });

        const baseVol = openPrice * 0.00006;
        const bodySize = baseVol * (0.5 + Math.random());
        let isGreen;

        if (upVolume > dnVolume) isGreen = false; // Majority UP, so candle is RED
        else if (dnVolume > upVolume) isGreen = true; // Majority DOWN, so candle is GREEN
        else isGreen = Math.random() > 0.5; // Random if no trades
        
        targetClose = isGreen ? openPrice + bodySize : openPrice - bodySize;
    }

    targetClose = roundPrice(targetClose);
    const isGreen = targetClose >= openPrice;
    
    // Generate Wicks
    const wickMax = Math.abs(targetClose - openPrice) * 0.5 + (openPrice * 0.00003);
    const high = roundPrice(Math.max(openPrice, targetClose) + (Math.random() * wickMax));
    const low = roundPrice(Math.min(openPrice, targetClose) - (Math.random() * wickMax));

    return { timestamp, open: roundPrice(openPrice), close: targetClose, high, low, color: isGreen ? 'GREEN' : 'RED', pattern: actionStr || 'AUTO' };
}

// Initialize Market (Starts from exact last price)
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.25000; // A more realistic default
    
    try {
        const snap = await db.ref(`markets/${path}/live`).once('value');
        if (snap.exists() && snap.val().price) {
            startPrice = snap.val().price;
            console.log(`Synced ${marketId} from Firebase Live Price: ${startPrice}`);
        }
    } catch (e) { console.log(`No live price for ${marketId}, starting new.`); }

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let lastClose = startPrice;

    for (let i = MAX_CANDLES; i > 0; i--) {
        const candleOpen = lastClose; // For reverse generation, open is last close
        const body = (Math.random() - 0.5) * 0.00012;
        const candleClose = candleOpen + body;
        const candleHigh = Math.max(candleOpen, candleClose) + Math.random() * 0.00008;
        const candleLow = Math.min(candleOpen, candleClose) - Math.random() * 0.00008;
        
        candles.unshift({ 
            timestamp: nowPeriod - (i * TIMEFRAME), 
            open: roundPrice(candleOpen), high: roundPrice(candleHigh), 
            low: roundPrice(candleLow), close: roundPrice(candleClose) 
        });
        lastClose = candleOpen;
    }
    candles[candles.length - 1].close = startPrice; // Ensure last candle matches start price

    markets[marketId] = {
        marketId, marketPath: path, history: candles, liveCandle: null,
        targetPattern: null, activeCommand: null, noise: 0
    };
    console.log(`Market Initialized: ${marketId}`);
}

function processMarketTick(marketData, currentPeriod) {
    const now = Date.now();
    
    if (!marketData.liveCandle || marketData.liveCandle.timestamp !== currentPeriod) {
        if (marketData.liveCandle) {
            const finishedCandle = { ...marketData.liveCandle };
            marketData.history.push(finishedCandle);
            if (marketData.history.length > MAX_CANDLES) marketData.history.shift();

            if (marketData.activeCommand) {
                const cmd = marketData.activeCommand;
                const resultColor = finishedCandle.close >= finishedCandle.open ? 'GREEN' : 'RED';
                db.ref(`admin/commands/${cmd.id}`).update({
                    status: 'Executed',
                    analytics: {
                        resultCandle: { 
                            open: finishedCandle.open, high: finishedCandle.high, 
                            low: finishedCandle.low, close: finishedCandle.close, 
                            color: resultColor, points: cmd.action 
                        }
                    }
                });
            }
        }

        let nextCmd = null;
        let pendingCmds = Object.values(adminCommands).filter(c => c.marketId === marketData.marketId && c.status === 'Pending');
        if (pendingCmds.length > 0) {
            pendingCmds.sort((a, b) => a.createdAt - b.createdAt);
            nextCmd = pendingCmds[0];
            db.ref(`admin/commands/${nextCmd.id}`).update({ status: 'Running', executedAt: currentPeriod });
        }
        marketData.activeCommand = nextCmd;

        const prevCandle = marketData.history[marketData.history.length - 1];
        const openPrice = prevCandle ? prevCandle.close : 1.25000;
        
        const target = generateTargetCandle(currentPeriod, openPrice, marketData.marketId, nextCmd?.action);
        marketData.targetPattern = target;
        marketData.liveCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.noise = 0;
        marketData.hitHigh = false;
        marketData.hitLow = false;
    }

    const target = marketData.targetPattern;
    const live = marketData.liveCandle;
    const timeElapsed = now - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    const noiseMax = Math.abs(target.close - target.open) * 0.20 * (1 - progress); 
    marketData.noise += (Math.random() - 0.5) * noiseMax;
    if (Math.abs(marketData.noise) > noiseMax) marketData.noise *= 0.5;

    let newPrice = expectedBasePath + marketData.noise;

    if (progress > 0.2 && progress < 0.8) {
        if (!marketData.hitHigh && Math.random() < 0.05) { newPrice = target.high; marketData.hitHigh = true; } 
        else if (!marketData.hitLow && Math.random() < 0.05) { newPrice = target.low; marketData.hitLow = true; }
    }

    if (progress >= 0.97) newPrice = target.close;

    live.close = roundPrice(newPrice);
    live.high = roundPrice(Math.max(live.high, live.close, newPrice));
    live.low = roundPrice(Math.min(live.low, live.close, newPrice));
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
                    const historyPayload = { type: 'history', market: msg.market, candles: markets[msg.market].history };
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
        processMarketTick(markets[marketId], currentPeriod);
        broadcastCandle(marketId, markets[marketId].liveCandle);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            if (m.liveCandle) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: m.liveCandle.close, timestamp: m.liveCandle.timestamp };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Synced Point-Based Server Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));