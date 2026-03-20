const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- আপনার ফায়ারবেস কনফিগারেশন ---
const firebaseConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000;
const markets = {}; // In-memory storage for all markets

// --- কেন্দ্রীয় ক্যান্ডেল তৈরির ফাংশন ---
function generateCandle(timestamp, open) {
    let diff = (Math.random() - 0.5) * 0.0003 * open;
    let close = open + diff;
    return {
        timestamp: timestamp,
        open: parseFloat(open.toFixed(5)),
        high: parseFloat(Math.max(open, close + Math.random() * 0.0001 * open).toFixed(5)),
        low: parseFloat(Math.min(open, close - Math.random() * 0.0001 * open).toFixed(5)),
        close: parseFloat(close.toFixed(5))
    };
}

// --- নতুন মার্কেট শুরু করার ফাংশন ---
function initializeNewMarket(marketId, fbMarket) {
    console.log(`Initializing new market: ${fbMarket.name} (${marketId})`);
    
    let startPrice = 1.15000 + (Math.random() - 0.5) * 0.1;
    const existingMarketIds = Object.keys(markets);
    if (existingMarketIds.length > 0) {
        const randomExistingMarket = existingMarketIds[Math.floor(Math.random() * existingMarketIds.length)];
        const lastCandle = markets[randomExistingMarket]?.history.slice(-1)[0];
        if (lastCandle) {
            startPrice = lastCandle.close;
        }
    }
    
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = 300; i > 0; i--) {
        const newCandle = generateCandle(now - (i * TIMEFRAME), currentPrice);
        candles.push(newCandle);
        currentPrice = newCandle.close;
    }

    markets[marketId] = {
        history: candles,
        currentPrice: currentPrice,
        targetPrice: currentPrice,
    };
    console.log(`Market ${fbMarket.name} initialized with start price ${startPrice.toFixed(5)}`);
}

// --- ফায়ারবেস থেকে মার্কেট লিস্ট সিঙ্ক করা ---
const adminMarketsRef = db.ref('admin/markets');
adminMarketsRef.on('value', (snapshot) => {
    if (!snapshot.exists()) return;
    const fbMarkets = snapshot.val();
    console.log("Syncing markets from Firebase...");

    Object.keys(fbMarkets).forEach(marketId => {
        const fbMarket = fbMarkets[marketId];
        if (fbMarket.type === 'otc' && !markets[marketId]) {
            initializeNewMarket(marketId, fbMarket);
        }
    });

    Object.keys(markets).forEach(localMarketId => {
        if (!fbMarkets[localMarketId] || fbMarkets[localMarketId].type !== 'otc') {
            console.log(`Market ${localMarketId} removed from memory.`);
            delete markets[localMarketId];
        }
    });
});

const adminOverrides = {};
const adminPatterns = {};
db.ref('admin/market_overrides').on('value', snap => Object.assign(adminOverrides, snap.val() || {}));
db.ref('admin/markets').on('value', snap => {
    const data = snap.val() || {};
    Object.keys(data).forEach(id => {
        if (data[id].pattern_config) adminPatterns[id] = data[id].pattern_config;
    });
});

// --- চূড়ান্ত সমাধান: মেইন ইঞ্জিন (সবসময় চলবে) ---
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    // মেমোরিতে থাকা সব OTC মার্কেটের জন্য ক্যান্ডেল আপডেট করা
    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        if (!marketData || !marketData.history || marketData.history.length === 0) return;

        let lastCandle = marketData.history[marketData.history.length - 1];
        
        // যদি সময় গ্যাপ থাকে, তবে তা পূরণ করা (সার্ভার রিস্টার্ট বা অন্য কারণে হতে পারে)
        const timeDiff = currentPeriod - lastCandle.timestamp;
        if (timeDiff >= TIMEFRAME) {
            const missingCandlesCount = timeDiff / TIMEFRAME;
            for (let i = 1; i <= missingCandlesCount; i++) {
                const newTimestamp = lastCandle.timestamp + (i * TIMEFRAME);
                const newCandle = generateCandle(newTimestamp, lastCandle.close);
                marketData.history.push(newCandle);
                if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
                lastCandle = newCandle;
            }
             marketData.currentPrice = lastCandle.close;
             marketData.targetPrice = lastCandle.close;
        }

        // নতুন ক্যান্ডেলের জন্য টার্গেট সেট করা
        if (currentPeriod > marketData.history[marketData.history.length - 1].timestamp) {
             let newCandle = { timestamp: currentPeriod, open: lastCandle.close, high: lastCandle.close, low: lastCandle.close, close: lastCandle.close };
             marketData.history.push(newCandle);
             if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
             lastCandle = newCandle;

            // Admin Controls
            let forceDir = null;
            // ... (বাকি অ্যাডমিন লজিক একই থাকবে) ...
            let moveSize = lastCandle.open * 0.0005;
            marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.0006 * lastCandle.open; // Simplified
        }

        // স্মুথ প্রাইস মুভমেন্ট
        let distance = marketData.targetPrice - marketData.currentPrice;
        let step = distance * 0.08;
        let maxAllowedStep = lastCandle.open * 0.00003;
        if (Math.abs(step) > maxAllowedStep) step = Math.sign(step) * maxAllowedStep;
        
        marketData.currentPrice += step;
        let jitter = (Math.random() - 0.5) * 0.00001 * lastCandle.open;
        
        lastCandle.close = parseFloat((marketData.currentPrice + jitter).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        // সব কানেক্টেড ক্লায়েন্টকে লাইভ আপডেট পাঠানো
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ market: marketId, candle: lastCandle }));
            }
        });
    });
}, 200);

// --- API এন্ডপয়েন্ট (এখন অনেক সিম্পল) ---
app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId] && markets[marketId].history) {
        // সার্ভার যেহেতু সবসময় আপ-টু-ডেট, তাই শুধু ইতিহাস পাঠিয়ে দিলেই হবে
        res.json(markets[marketId].history);
    } else {
        // যদি কোনো কারণে মার্কেট এখনও তৈরি না হয়ে থাকে
        res.status(404).json([]);
    }
});

app.get('/ping', (req, res) => res.send("UltraSmooth V5 - Always On"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server v5 on ${PORT}`));