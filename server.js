const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- আপনার ফায়ারবেস কনফিগ এখানে বসান ---
const firebaseConfig = {
    apiKey: "AIzaSyBspVTNDTLn2zuwwI7580vqHABrAjJl63o",
    authDomain: "earning-xone-v1.firebaseapp.com",
    databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com",
    projectId: "earning-xone-v1",
    storageBucket: "earning-xone-v1.appspot.com",
    messagingSenderId: "471994174185",
    appId: "1:471994174185:web:eb45e6c24a66b40c34fe78"
};

firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000; 
const markets = {};

// ক্যান্ডেল জেনারেটর ফাংশন
function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        let body = (Math.random() - 0.5) * 0.002 * startPrice;
        let close = open + body;
        candles.push({
            timestamp: now - (i * TIMEFRAME),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(Math.max(open, close + Math.random() * 0.001).toFixed(5)),
            low: parseFloat(Math.min(open, close - Math.random() * 0.001).toFixed(5)),
            close: parseFloat(close.toFixed(5))
        });
        currentPrice = close;
    }
    return { history: candles, currentPrice: currentPrice, targetPrice: currentPrice };
}

// 🔴 অ্যাডমিন কন্ট্রোল লজিক: ফায়ারবেস থেকে কমান্ড পড়া
const adminOverrides = {};
const adminPatterns = {};

// ১. কুইক ওভাররাইড (UP/DOWN) শোনা
db.ref('admin/market_overrides').on('value', (snap) => {
    const data = snap.val();
    if (data) Object.assign(adminOverrides, data);
});

// ২. প্যাটার্ন সিকোয়েন্স শোনা
db.ref('admin/markets').on('value', (snap) => {
    const data = snap.val();
    if (data) {
        Object.keys(data).forEach(id => {
            if (data[id].pattern_config) {
                adminPatterns[id] = data[id].pattern_config;
            }
        });
    }
});

// 🟢 মেইন লজিক: প্রতি ২০০ মিলিসেকেন্ডে চার্ট আপডেট
setInterval(() => {
    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        let history = marketData.history;
        let lastCandle = history[history.length - 1];

        if (now > lastCandle.timestamp) {
            // নতুন ক্যান্ডেল শুরু
            let newCandle = { timestamp: now, open: lastCandle.close, high: lastCandle.close, low: lastCandle.close, close: lastCandle.close };
            history.push(newCandle);
            if (history.length > MAX_CANDLES) history.shift();
            lastCandle = newCandle;

            // অ্যাডমিন কমান্ড চেক করা (পরবর্তী ক্যান্ডেলের জন্য)
            let forceDirection = null;

            // কুইক ওভাররাইড চেক
            if (adminOverrides[marketId]) {
                forceDirection = adminOverrides[marketId].type;
                delete adminOverrides[marketId]; // একবার কাজ হয়ে গেলে ডিলিট
                db.ref(`admin/market_overrides/${marketId}`).remove();
            } 
            // প্যাটার্ন সিকোয়েন্স চেক
            else if (adminPatterns[marketId] && adminPatterns[marketId].isActive) {
                const config = adminPatterns[marketId];
                const index = Math.floor((now - config.startTime) / (config.timeframe * 1000));
                if (index >= 0 && index < config.pattern.length) {
                    forceDirection = config.pattern[index];
                } else if (index >= config.pattern.length) {
                    delete adminPatterns[marketId]; // প্যাটার্ন শেষ হলে ডিলিট
                }
            }

            // টার্গেট প্রাইস সেট করা
            let movement = (Math.random() * 0.002) * lastCandle.open;
            if (forceDirection === 'UP' || forceDirection === 'GREEN') {
                marketData.targetPrice = lastCandle.open + movement + 0.001;
            } else if (forceDirection === 'DOWN' || forceDirection === 'RED') {
                marketData.targetPrice = lastCandle.open - movement - 0.001;
            } else {
                marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.002 * lastCandle.open;
            }
        }

        // স্মুথ মুভমেন্ট
        marketData.currentPrice += (marketData.targetPrice - marketData.currentPrice) * 0.12;
        lastCandle.close = parseFloat(marketData.currentPrice.toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        const liveData = JSON.stringify({ market: marketId, candle: lastCandle });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(liveData);
        });
    });
}, 200);

// API Endpoint
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (!markets[market]) {
        markets[market] = generateInitialCandles(1.15000 + (Math.random() * 0.1), MAX_CANDLES);
    }
    res.json(markets[market].history.slice(-500));
});

app.get('/ping', (req, res) => res.send("Awake!"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));