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

// --- নতুন কোড: ফায়ারবেস থেকে মার্কেট লিস্ট লোড করা ---
const adminMarketsRef = db.ref('admin/markets');

function initializeNewMarket(marketId, fbMarket) {
    console.log(`New market detected: ${fbMarket.name} (${marketId}). Initializing...`);
    
    // Smooth start-এর জন্য অন্য কোনো চলমান মার্কেট থেকে দাম নেয়া
    let startPrice = 1.15000; // ডিফল্ট প্রাইস
    const existingMarketIds = Object.keys(markets);
    if (existingMarketIds.length > 0) {
        const lastMarketKey = existingMarketIds[existingMarketIds.length - 1];
        if (markets[lastMarketKey] && markets[lastMarketKey].history.length > 0) {
            startPrice = markets[lastMarketKey].history[markets[lastMarketKey].history.length - 1].close;
        }
    }
    
    markets[marketId] = generateInitialCandles(startPrice, 300); // নতুন মার্কেটের জন্য কম ক্যান্ডেল দিয়ে শুরু
    console.log(`Market ${fbMarket.name} initialized with start price ${startPrice}`);
}

adminMarketsRef.on('value', (snapshot) => {
    if (!snapshot.exists()) {
        console.log("No markets found in Firebase admin/markets.");
        return;
    }
    const fbMarkets = snapshot.val();
    console.log("Syncing markets from Firebase...");

    // নতুন মার্কেট যোগ করা হয়েছে কিনা চেক করা
    Object.keys(fbMarkets).forEach(marketId => {
        const fbMarket = fbMarkets[marketId];
        if (fbMarket.type === 'otc' && !markets[marketId]) {
            initializeNewMarket(marketId, fbMarket);
        }
    });

    // সার্ভারের মেমোরি থেকে ডিলিট হয়ে যাওয়া মার্কেট মুছে ফেলা
    Object.keys(markets).forEach(localMarketId => {
        if (!fbMarkets[localMarketId] || fbMarkets[localMarketId].type !== 'otc') {
            console.log(`Market ${localMarketId} removed from memory.`);
            delete markets[localMarketId];
        }
    });
});
// --- নতুন কোড শেষ ---

function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        let diff = (Math.random() - 0.5) * 0.0003 * startPrice;
        let close = open + diff;
        candles.push({
            timestamp: now - (i * TIMEFRAME),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(Math.max(open, close + Math.random() * 0.0001 * startPrice).toFixed(5)),
            low: parseFloat(Math.min(open, close - Math.random() * 0.0001 * startPrice).toFixed(5)),
            close: parseFloat(close.toFixed(5))
        });
        currentPrice = close;
    }
    return {
        history: candles,
        currentPrice: currentPrice,
        targetPrice: currentPrice,
        velocity: 0
    };
}

const adminOverrides = {};
const adminPatterns = {};

db.ref('admin/market_overrides').on('value', snap => {
    const data = snap.val();
    if (data) Object.assign(adminOverrides, data);
});

db.ref('admin/markets').on('value', snap => {
    const data = snap.val();
    if (data) {
        Object.keys(data).forEach(id => {
            if (data[id].pattern_config) adminPatterns[id] = data[id].pattern_config;
        });
    }
});

// মেইন ইঞ্জিন
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        let history = marketData.history;
        if (!history || history.length === 0) return;

        let lastCandle = history[history.length - 1];

        if (currentPeriod > lastCandle.timestamp) {
            let newCandle = {
                timestamp: currentPeriod,
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            history.push(newCandle);
            if (history.length > MAX_CANDLES) history.shift();
            lastCandle = newCandle;

            let forceDir = null;
            if (adminOverrides[marketId]) {
                forceDir = adminOverrides[marketId].type;
                delete adminOverrides[marketId];
                db.ref(`admin/market_overrides/${marketId}`).remove();
            } else if (adminPatterns[marketId] && adminPatterns[marketId].isActive) {
                const config = adminPatterns[marketId];
                const index = Math.floor((currentPeriod - config.startTime) / (config.timeframe * 1000));
                if (index >= 0 && index < config.pattern.length) {
                    forceDir = config.pattern[index];
                }
            }

            let moveSize = lastCandle.open * 0.0005;
            if (forceDir && forceDir.startsWith('PATTERN_CUSTOM_')) {
                const p = forceDir.split('_');
                const body = parseInt(p[4]);
                const totalScale = lastCandle.open * 0.0009;
                marketData.targetPrice = (p[2] === 'GREEN') ? lastCandle.open + (totalScale * (body / 100)) : lastCandle.open - (totalScale * (body / 100));
            } else if (['UP', 'GREEN'].some(d => String(forceDir).includes(d))) {
                marketData.targetPrice = lastCandle.open + moveSize;
            } else if (['DOWN', 'RED'].some(d => String(forceDir).includes(d))) {
                marketData.targetPrice = lastCandle.open - moveSize;
            } else {
                marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.0006 * lastCandle.open;
            }
        }

        let distance = marketData.targetPrice - marketData.currentPrice;
        let step = distance * 0.08;
        let maxAllowedStep = lastCandle.open * 0.00003;
        if (Math.abs(step) > maxAllowedStep) {
            step = Math.sign(step) * maxAllowedStep;
        }
        marketData.currentPrice += step;
        let jitter = (Math.random() - 0.5) * 0.00001 * lastCandle.open;
        
        lastCandle.close = parseFloat((marketData.currentPrice + jitter).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ market: marketId, candle: lastCandle }));
            }
        });
    });
}, 200);

// --- ***সবচেয়ে গুরুত্বপূর্ণ পরিবর্তন এখানে*** ---
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (markets[market] && markets[market].history) {
        // যদি মার্কেট মেমোরিতে থাকে, তাহলে ইতিহাস পাঠিয়ে দাও
        res.json(markets[market].history);
    } else {
        // যদি মার্কেট মেমোরিতে না থাকে, তাহলে একটি খালি অ্যারে পাঠাও
        // অ্যাপ নিজে থেকেই আবার চেষ্টা করবে
        console.log(`History requested for uninitialized market: ${market}. Sending empty array for client to retry.`);
        res.json([]); 
    }
});

app.get('/ping', (req, res) => res.send("UltraSmooth"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server on ${PORT}`));