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
const markets = {};

// ক্যান্ডেল জেনারেটর (স্মুথ হিস্ট্রি)
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
        velocity: 0 // গতির হিসাব রাখার জন্য
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

// 🟢 মেইন ইঞ্জিন: ফিজিক্স বেসড স্মুথ মুভমেন্ট
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        let history = marketData.history;
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

            // অ্যাডমিন কন্ট্রোল চেক
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

            // টার্গেট সেট করা
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

        // 🧠 স্মুথিং লজিক: "Ease-Out" মুভমেন্ট
        // প্রাইস হুট করে লাফাবে না, বরং গন্তব্যের দিকে ধীরে ধীরে এগোবে
        let distance = marketData.targetPrice - marketData.currentPrice;
        let step = distance * 0.08; // প্রতি টিক-এ ৮% দূরত্ব অতিক্রম করবে

        // সর্বোচ্চ গতির সীমা (Hard limit to prevent jumps)
        let maxAllowedStep = lastCandle.open * 0.00003; 
        if (Math.abs(step) > maxAllowedStep) {
            step = Math.sign(step) * maxAllowedStep;
        }

        marketData.currentPrice += step;

        // হালকা মার্কেট নয়েজ (কাঁপাকাঁপি)
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

app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (!markets[market]) {
        let startPrice = 1.15000 + (Math.random() * 0.02);
        markets[market] = generateInitialCandles(startPrice, MAX_CANDLES);
    }
    res.json(markets[market].history.slice(-500));
});

app.get('/ping', (req, res) => res.send("UltraSmooth"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server on ${PORT}`));