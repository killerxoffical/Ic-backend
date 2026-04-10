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
const TICK_MS = 200;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 150;

const markets = {}; 
let adminCommands = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen for ALL Admin Commands globally
db.ref('admin/commands').on('value', (snapshot) => {
    adminCommands = snapshot.val() || {};
});

// 🔥 CORE LOGIC: PRECISE PATTERN GENERATOR 🔥
function generateTargetPattern(timestamp, prevCandle, action) {
    const openPrice = prevCandle ? prevCandle.close : 1.15000;
    let baseVol = openPrice * 0.00006;
    
    // Default Random Candle
    let body = baseVol * (0.5 + Math.random());
    let upWick = baseVol * Math.random();
    let dnWick = baseVol * Math.random();
    let isGreen = Math.random() > 0.5;

    if (action) {
        // BULLISH PATTERNS (GREEN)
        if (action === 'PATTERN_MARUBOZU_GREEN') {
            isGreen = true; body = baseVol * 3.5; upWick = 0; dnWick = 0;
        } 
        else if (action === 'PATTERN_HAMMER' || action === 'PATTERN_BULLISH_PINBAR') {
            isGreen = true; body = baseVol * 0.8; upWick = baseVol * 0.2; dnWick = baseVol * 3.0;
        }
        else if (action === 'PATTERN_BULLISH_SPINNING') {
            isGreen = true; body = baseVol * 0.8; upWick = baseVol * 2.0; dnWick = baseVol * 2.0;
        }
        else if (action === 'PATTERN_DRAGONFLY_DOJI') {
            isGreen = true; body = baseVol * 0.02; upWick = 0; dnWick = baseVol * 3.0;
        }

        // BEARISH PATTERNS (RED)
        else if (action === 'PATTERN_MARUBOZU_RED') {
            isGreen = false; body = baseVol * 3.5; upWick = 0; dnWick = 0;
        }
        else if (action === 'PATTERN_SHOOTING_STAR' || action === 'PATTERN_BEARISH_PINBAR') {
            isGreen = false; body = baseVol * 0.8; upWick = baseVol * 3.0; dnWick = baseVol * 0.2;
        }
        else if (action === 'PATTERN_BEARISH_SPINNING') {
            isGreen = false; body = baseVol * 0.8; upWick = baseVol * 2.0; dnWick = baseVol * 2.0;
        }
        else if (action === 'PATTERN_GRAVESTONE_DOJI') {
            isGreen = false; body = baseVol * 0.02; upWick = baseVol * 3.0; dnWick = 0;
        }

        // NEUTRAL
        else if (action === 'PATTERN_STANDARD_DOJI') {
            isGreen = Math.random() > 0.5; body = baseVol * 0.02; upWick = baseVol * 1.5; dnWick = baseVol * 1.5;
        }
        else if (action === 'PATTERN_LONG_LEGGED_DOJI') {
            isGreen = Math.random() > 0.5; body = baseVol * 0.05; upWick = baseVol * 3.5; dnWick = baseVol * 3.5;
        }
        
        // ADVANCED BREAKOUTS
        else if (action.includes('UP_INSIDE') || action.includes('DOWN_INSIDE')) {
            isGreen = action.includes('UP'); body = baseVol * 0.5; upWick = baseVol * 0.2; dnWick = baseVol * 0.2;
        }
        else if (action.includes('UP_BREAKOUT') || action.includes('DOWN_BREAKOUT')) {
            isGreen = action.includes('UP'); body = baseVol * 1.8; upWick = baseVol * 0.3; dnWick = baseVol * 0.3;
        }
        else if (action.includes('UP_2X') || action.includes('DOWN_2X')) {
            isGreen = action.includes('UP'); body = baseVol * 3.0; upWick = baseVol * 0.5; dnWick = baseVol * 0.5;
        }
        else if (action === 'OPPOSITE_BREAKOUT') {
            if(prevCandle) {
                const prevWasGreen = prevCandle.close >= prevCandle.open;
                const prevBody = Math.abs(prevCandle.close - prevCandle.open);
                isGreen = !prevWasGreen;
                body = prevBody * (1.3 + Math.random() * 0.4);
                upWick = body * 0.2; dnWick = body * 0.2;
            } else {
                isGreen = Math.random() > 0.5; body = baseVol * 1.5;
            }
        }
    }

    const close = isGreen ? openPrice + body : openPrice - body;
    const high = Math.max(openPrice, close) + upWick;
    const low = Math.min(openPrice, close) - dnWick;

    return { timestamp, open: roundPrice(openPrice), close: roundPrice(close), high: roundPrice(high), low: roundPrice(low), color: isGreen ? 'GREEN' : 'RED', pattern: action || 'RANDOM' };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentCandle = null;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const target = generateTargetPattern(nowPeriod - (i * TIMEFRAME), currentCandle, null);
        currentCandle = target;
        candles.push({ timestamp: target.timestamp, open: target.open, high: target.high, low: target.low, close: target.close });
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
}

function processMarketTick(marketData, currentPeriod) {
    const now = Date.now();
    
    // 1. MINUTE CHANGED: Finalize old candle & Setup new candle
    if (!marketData.liveCandle || marketData.liveCandle.timestamp !== currentPeriod) {
        
        // Push finished candle to history and execute command
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
                            color: resultColor, pattern: marketData.targetPattern.pattern 
                        },
                        executedAt: Date.now()
                    }
                });
            }
        }

        // Fetch Next Command
        let nextCmd = null;
        let pendingCmds = Object.values(adminCommands).filter(c => c.marketId === marketData.marketId && c.status === 'Pending');
        if (pendingCmds.length > 0) {
            pendingCmds.sort((a, b) => a.createdAt - b.createdAt);
            nextCmd = pendingCmds[0];
            db.ref(`admin/commands/${nextCmd.id}`).update({ status: 'Running', executedAt: currentPeriod });
        }
        
        marketData.activeCommand = nextCmd;

        // Generate Target for New Minute
        const prevCandle = marketData.history.length > 0 ? marketData.history[marketData.history.length - 1] : null;
        const target = generateTargetPattern(currentPeriod, prevCandle, nextCmd?.action);
        marketData.targetPattern = target;

        // Initialize Live Candle
        marketData.liveCandle = {
            timestamp: currentPeriod,
            open: target.open,
            high: target.open,
            low: target.open,
            close: target.open
        };
        marketData.noise = 0;
        marketData.hitHigh = false;
        marketData.hitLow = false;
    }

    // 2. ANIMATE LIVE CANDLE SMOOTHLY
    const target = marketData.targetPattern;
    const live = marketData.liveCandle;
    const timeElapsed = now - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    const noiseMax = Math.abs(target.close - target.open) * 0.15 * (1 - progress); 
    
    marketData.noise += (Math.random() - 0.5) * noiseMax;
    if (Math.abs(marketData.noise) > noiseMax) marketData.noise *= 0.5;

    let newPrice = expectedBasePath + marketData.noise;

    // Force hit High and Low inside the timeframe
    if (progress > 0.25 && progress < 0.75) {
        if (!marketData.hitHigh && Math.random() < 0.05) { newPrice = target.high; marketData.hitHigh = true; } 
        else if (!marketData.hitLow && Math.random() < 0.05) { newPrice = target.low; marketData.hitLow = true; }
    }

    // Snap to exact close price at the end
    if (progress >= 0.97) newPrice = target.close;

    live.close = roundPrice(newPrice);
    live.high = roundPrice(Math.max(live.high, live.close, newPrice));
    live.low = roundPrice(Math.min(live.low, live.close, newPrice));

    // Ensure it never crosses hard targets
    if(target.color === 'GREEN') {
        live.high = Math.min(live.high, target.high);
        live.low = Math.max(live.low, target.low);
    } else {
        live.high = Math.min(live.high, target.high);
        live.low = Math.max(live.low, target.low);
    }
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

app.get('/ping', (_req, res) => res.send('WebSocket Perfect Next-Candle Engine Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));