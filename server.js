// 🔥 ICTEX Trade Engine V23 - "Safe Decision Window" Architecture
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- Firebase Config ---
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

// --- Constants ---
const MAX_CANDLES = 1500;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const DECISION_WINDOW_MS = 5000; // 5 সেকেন্ড পর সিদ্ধান্ত নিবে
const HISTORY_SEED_COUNT = 300;
const MIN_PRICE = 0.00001;

// --- In-Memory State ---
const markets = {}; 

// --- Helper Functions ---
function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Firebase Listeners ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// --- Candle Generation ---
function generateHistoricalCandle(timestamp, open) {
    const isGreen = Math.random() > 0.5;
    const body = (0.00006 + Math.random() * 0.00025) * open;
    const close = isGreen ? open + body : open - body;
    const upperWick = (0.00003 + Math.random() * 0.00015) * open;
    const lowerWick = (0.00003 + Math.random() * 0.00015) * open;
    return { timestamp, open: roundPrice(open), high: roundPrice(Math.max(open, close) + upperWick), low: roundPrice(Math.min(open, close) - lowerWick), close: roundPrice(close) };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = 1.15;

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
        candles.push(c);
        currentPrice = c.close;
    }
    
    // Store in Firebase
    const historyRef = db.ref(`market_history/${marketId}`);
    await historyRef.set(candles);

    markets[marketId] = {
        marketId,
        marketPath: path,
        currentPrice: currentPrice,
        candleStartTime: 0,
        decisionMade: false,
        targetClose: null,
    };
}


// 🔥🔥🔥 মূল পরিবর্তন এখানে 🔥🔥🔥
// Step 1: নতুন ক্যান্ডেল শুরু হলে শুধু একটি খালি শেল তৈরি করা
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    const historyRef = db.ref(`market_history/${marketData.marketId}`);
    
    historyRef.orderByKey().limitToLast(1).once('value', (snapshot) => {
        const lastCandleArr = snapshot.val();
        if(!lastCandleArr) return;
        const lastCandle = lastCandleArr[Object.keys(lastCandleArr).length-1];
        
        if (currentPeriod > lastCandle.timestamp) {
            const newCandle = {
                timestamp: currentPeriod,
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close,
            };

            // Update state
            marketData.candleStartTime = currentPeriod;
            marketData.decisionMade = false;
            marketData.targetClose = null;
            marketData.currentPrice = newCandle.open;
            
            // Add new empty candle to history
            historyRef.push(newCandle);
            db.ref(`market_history/${marketData.marketId}`).orderByKey().limitToFirst(1).once('value', s => {
                if(s.exists()){
                     db.ref(`market_history/${marketData.marketId}/${Object.keys(s.val())[0]}`).remove();
                }
            });
        }
    });
}

// Step 2: "সেফ ডিসিশন উইন্ডো"-তে সিদ্ধান্ত গ্রহণ
async function makeDecisionForCurrentCandle(marketData) {
    if (marketData.decisionMade) return;

    const openPrice = marketData.currentPrice; // Open price is the current price at decision time
    let finalColor = null;

    // 1. Check for Admin Command
    const patternSnap = await db.ref(`admin/markets/${marketData.marketId}/pattern_config`).once('value');
    const adminPattern = patternSnap.val();
    if (adminPattern && adminPattern.isActive && adminPattern.startTime === marketData.candleStartTime) {
        finalColor = adminPattern.pattern[0]; // 'GREEN' or 'RED'
        db.ref(`admin/markets/${marketData.marketId}/pattern_config`).remove(); // Command used, so remove it
    }

    // 2. If no Admin command, check user trades
    if (!finalColor) {
        const tradesSnap = await db.ref(`active_trades/${marketData.marketId}`).once('value');
        const trades = tradesSnap.val() || {};
        let totalUp = 0, totalDown = 0;
        Object.values(trades).forEach(trade => {
            if (trade.direction === 'UP') totalUp += trade.amount;
            else if (trade.direction === 'DOWN') totalDown += trade.amount;
        });

        if (totalUp > totalDown) finalColor = 'RED'; // Win for platform
        else if (totalDown > totalUp) finalColor = 'GREEN'; // Win for platform
        else finalColor = Math.random() > 0.5 ? 'GREEN' : 'RED'; // Random if equal
        
        if(trades) db.ref(`active_trades/${marketData.marketId}`).remove();
    }
    
    // 3. Lock the Target
    const bodySize = openPrice * (0.0001 + Math.random() * 0.00015);
    marketData.targetClose = finalColor === 'GREEN' ? openPrice + bodySize : openPrice - bodySize;
    marketData.decisionMade = true;
    
    console.log(`[DECISION @ ${new Date().getSeconds()}s] Market: ${marketData.marketId} -> ${finalColor}`);
}

// Step 3: লাইভ প্রাইসকে টার্গেটের দিকে টেনে নেওয়া
function updateRealisticPrice(marketData, currentCandleInHistory) {
    const now = Date.now();
    const elapsedMs = now - marketData.candleStartTime;
    const progress = Math.min(elapsedMs / TIMEFRAME, 1.0);

    const baseVolatility = currentCandleInHistory.open * 0.00004;
    let tickMove = (Math.random() - 0.5) * baseVolatility * 2;

    if (marketData.decisionMade) {
        const distanceToTarget = marketData.targetClose - marketData.currentPrice;
        const pullStrength = progress > 0.1 ? (progress - 0.1) / 0.9 : 0;
        tickMove += (distanceToTarget * pullStrength * 0.15);
    }
    
    marketData.currentPrice += tickMove;

    return roundPrice(marketData.currentPrice);
}

// --- WebSocket & API ---
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') ws.subscribedMarket = msg.market;
        } catch (_) {}
    });
});

app.get('/api/history/:marketId', async (req, res) => {
    const marketId = req.params.marketId;
    try {
        const snap = await db.ref(`market_history/${marketId}`).orderByKey().limitToLast(1500).once('value');
        if(snap.exists()){
            res.json(Object.values(snap.val()));
        } else {
             res.status(404).json({ error: 'History not found' });
        }
    } catch(e) {
        res.status(500).json({ error: 'Server error' });
    }
});

// --- Main Loop ---
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const secondsInMinute = new Date(now).getSeconds();

    for (const marketId in markets) {
        const marketData = markets[marketId];
        
        // Ensure new candle shell is created at the start of the minute
        ensureCurrentPeriodCandle(marketData, currentPeriod);

        // Make the decision after the "Safe Decision Window"
        if (secondsInMinute >= 5 && !marketData.decisionMade) {
            makeDecisionForCurrentCandle(marketData);
        }

        // Send live ticks to clients
        db.ref(`market_history/${marketId}`).orderByKey().limitToLast(1).once('value', snap => {
            if(!snap.exists()) return;
            const currentCandle = Object.values(snap.val())[0];
            const livePrice = updateRealisticPrice(marketData, currentCandle);
            
            const payload = JSON.stringify({
                market: marketId,
                candle: {
                    ...currentCandle,
                    close: livePrice,
                    high: Math.max(currentCandle.high, livePrice),
                    low: Math.min(currentCandle.low, livePrice)
                },
                serverTime: now
            });
            
            wss.clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                    client.send(payload);
                }
            });
        });
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('ICTEX Engine V23 - Safe Decision Window Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Engine running on ${PORT}`));