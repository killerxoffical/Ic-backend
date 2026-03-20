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

// --- ফায়ারবেস থেকে মার্কেট লিস্ট লোড এবং সিঙ্ক করা ---
const adminMarketsRef = db.ref('admin/markets');

function initializeNewMarket(marketId, fbMarket) {
    console.log(`Initializing new market: ${fbMarket.name} (${marketId})`);
    
    let startPrice = 1.15000 + (Math.random() - 0.5) * 0.1; // ডিফল্ট প্রাইস + র‍্যান্ডম ভ্যারিয়েশন
    const existingMarketIds = Object.keys(markets);
    if (existingMarketIds.length > 0) {
        const randomExistingMarket = existingMarketIds[Math.floor(Math.random() * existingMarketIds.length)];
        const lastCandle = markets[randomExistingMarket]?.history.slice(-1)[0];
        if (lastCandle) {
            startPrice = lastCandle.close;
        }
    }
    
    markets[marketId] = generateInitialCandles(startPrice, 300);
    console.log(`Market ${fbMarket.name} initialized with start price ${startPrice.toFixed(5)}`);
}

adminMarketsRef.on('value', (snapshot) => {
    if (!snapshot.exists()) {
        console.log("No markets found in Firebase admin/markets.");
        return;
    }
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
// --- মার্কেট সিঙ্ক শেষ ---

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
            if (adminOverrides[marketId] && adminOverrides[marketId].timestamp > Date.now() - (60 * 1000)) {
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
                const body = parseInt(p[4]) || 40;
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

// --- *** API এন্ডপয়েন্ট এর চূড়ান্ত সমাধান *** ---
app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    
    // ১. চেক করা যে মার্কেটটি মেমোরিতে আছে কিনা
    if (markets[marketId] && markets[marketId].history) {
        const marketData = markets[marketId];
        const lastCandle = marketData.history[marketData.history.length - 1];
        const now = Date.now();
        const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
        const timeDiff = currentPeriod - lastCandle.timestamp;

        // ২. ইতিহাস পুরানো হয়ে গেছে কিনা চেক করা
        if (timeDiff > 0) {
            const missingCandlesCount = timeDiff / TIMEFRAME;
            console.log(`History for ${marketId} is stale. Generating ${missingCandlesCount} missing candles.`);
            let latestPrice = lastCandle.close;
            for (let i = 1; i <= missingCandlesCount; i++) {
                const newTimestamp = lastCandle.timestamp + (i * TIMEFRAME);
                let open = latestPrice;
                let diff = (Math.random() - 0.5) * 0.0001 * open; // কম ভলাটিলিটি দিয়ে গ্যাপ পূরণ
                let close = open + diff;
                const newCandle = {
                    timestamp: newTimestamp,
                    open: parseFloat(open.toFixed(5)),
                    high: parseFloat(Math.max(open, close).toFixed(5)),
                    low: parseFloat(Math.min(open, close).toFixed(5)),
                    close: parseFloat(close.toFixed(5))
                };
                marketData.history.push(newCandle);
                if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
                latestPrice = close;
            }
            // ৩. নতুন ক্যান্ডেল জেনারেট করার পর লাইভ প্রাইস আপডেট করা
            marketData.currentPrice = latestPrice;
            marketData.targetPrice = latestPrice;
        }
        // ৪. আপ-টু-ডেট ইতিহাস পাঠানো
        res.json(marketData.history);
    } else {
        // ৫. মার্কেট মেমোরিতে না থাকলে, খালি উত্তর পাঠানো যাতে ক্লায়েন্ট আবার চেষ্টা করে
        console.warn(`History requested for uninitialized market: ${marketId}. Sending empty array for client retry.`);
        res.json([]); 
    }
});


app.get('/ping', (req, res) => res.send("UltraSmooth"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server on ${PORT}`));