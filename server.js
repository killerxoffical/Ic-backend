// --- START: FULLY UPDATED server.js (v17 - Memory & Stability Fix) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// Firebase Config
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

// Server Config
const MAX_CANDLES_IN_RAM = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300; 
const HISTORY_SEED_COUNT = 300;
const markets = {};

// Helper Functions
const roundPrice = v => parseFloat(v.toFixed(5));
const marketPathFromId = id => String(id || '').replace(/[\.\/ ]/g, '-').toLowerCase();
const cloneCandle = c => ({ ...c });

function generateHistoricalCandle(timestamp, open) {
    const safeOpen = Math.max(0.00001, open);
    const isGreen = Math.random() > 0.5;
    const body = (0.00006 + Math.random() * 0.00022) * safeOpen;
    const close = isGreen ? safeOpen + body : safeOpen - body;
    const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
    const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
    return {
        timestamp,
        open: roundPrice(safeOpen),
        high: roundPrice(Math.max(safeOpen, close) + upperWick),
        low: roundPrice(Math.min(safeOpen, close) - lowerWick),
        close: roundPrice(close)
    };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15;
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        const lastLive = liveSnap.val();
        if (lastLive && lastLive.price) {
            startPrice = lastLive.price;
            console.log(`[Restored] ${marketId} from price: ${startPrice}`);
        }
    } catch (e) {
        console.error("Restore error:", e);
    }
    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = Array.from({ length: HISTORY_SEED_COUNT }, (_, i) => 
        generateHistoricalCandle(nowPeriod - ((HISTORY_SEED_COUNT - i) * TIMEFRAME), startPrice)
    );
    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        currentPrice: candles[candles.length - 1].close
    };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    if (!lastCandle) return null;
    if (currentPeriod > lastCandle.timestamp) {
        const newCandle = {
            timestamp: currentPeriod,
            open: lastCandle.close,
            high: lastCandle.close,
            low: lastCandle.close,
            close: lastCandle.close
        };
        marketData.history.push(newCandle);
        if (marketData.history.length > MAX_CANDLES_IN_RAM) marketData.history.shift();
        return newCandle;
    }
    return lastCandle;
}

function updateCandlePrice(marketData, candle) {
    const volatility = 0.00015;
    let move = (Math.random() - 0.495) * (candle.open * volatility);
    const meanReversionForce = (candle.open - marketData.currentPrice) * 0.01;
    move += meanReversionForce;
    marketData.currentPrice += move;
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = roundPrice(Math.max(candle.high, candle.close));
    candle.low = roundPrice(Math.min(candle.low, candle.close));
}

// Market & WebSocket Listeners
db.ref('admin/markets').on('value', snapshot => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(id => {
        if (!markets[id] && fbMarkets[id].status === 'active' && (fbMarkets[id].type === 'otc' || fbMarkets[id].type === 'broker_real')) {
            initializeNewMarket(id);
        }
    });
});
wss.on('connection', ws => {
    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);
            if (msg.type === 'subscribe' && msg.market) ws.subscribedMarket = msg.market;
        } catch(e) {}
    });
});

// 🔥 STABILITY FIX: মেইন লুপটিকে `async` করা হয়েছে এবং `try-catch` যোগ করা হয়েছে
// এটি সার্ভারকে যে কোনো আনএক্সপেক্টেড এরর থেকে বাঁচাবে এবং ক্র্যাশ হওয়া বন্ধ করবে
(async () => {
    let lastSyncMinute = 0;
    setInterval(async () => {
        try {
            const now = Date.now();
            const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
            const currentMinute = Math.floor(now / 60000);
            
            // 1. Chart Update & Broadcast
            for (const marketId in markets) {
                const marketData = markets[marketId];
                let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
                if (!candle) continue;
                updateCandlePrice(marketData, candle);
                const payload = JSON.stringify({ market: marketId, candle, serverTime: now });
                wss.clients.forEach(client => {
                    if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
                        client.send(payload);
                    }
                });
            }

            // 2. Firebase Backup (Batch)
            if (currentMinute > lastSyncMinute) {
                lastSyncMinute = currentMinute;
                const batchUpdates = {};
                for (const marketId in markets) {
                    const marketData = markets[marketId];
                    const lastCandle = marketData.history[marketData.history.length-1];
                    if (lastCandle) {
                        batchUpdates[`markets/${marketData.marketPath}/live`] = { price: lastCandle.close, timestamp: lastCandle.timestamp };
                    }
                }
                if (Object.keys(batchUpdates).length > 0) {
                    await db.ref().update(batchUpdates);
                    console.log(`[Firebase Backup] Batched sync successful.`);
                }
            }
        } catch (error) {
            console.error("Main loop error, but server is safe:", error);
        }
    }, TICK_MS);
})();

// API routes
app.get('/api/history/:market', (req, res) => {
    const marketData = markets[req.params.market];
    if (!marketData) return res.status(404).json([]);
    res.json(marketData.history.map(cloneCandle));
});
app.post('/api/backup', async (req, res) => {
    try {
        const batchUpdates = {};
        for (const marketId in markets) {
            const marketData = markets[marketId];
            const lastCandle = marketData.history[marketData.history.length - 1];
            if (lastCandle) {
                batchUpdates[`markets/${marketData.marketPath}/live`] = { price: lastCandle.close, timestamp: lastCandle.timestamp };
            }
        }
        await db.ref().update(batchUpdates);
        res.json({ success: true, message: "Backup successful." });
    } catch (err) { res.status(500).json({ success: false, message: "Backup failed." }); }
});
app.get('/ping', (_req, res) => res.send('UltraSmooth v17 Stable'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server v17 Stable active on ${PORT}`));

// --- END OF FILE ---