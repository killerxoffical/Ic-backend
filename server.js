const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- ফায়ারবেস কনফিগারেশন ---
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
}

const adminMarketsRef = db.ref('admin/markets');
adminMarketsRef.on('value', (snapshot) => {
    if (!snapshot.exists()) return;
    const fbMarkets = snapshot.val();
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId].type === 'otc' && !markets[marketId]) {
            initializeNewMarket(marketId, fbMarkets[marketId]);
        }
    });
    Object.keys(markets).forEach(localMarketId => {
        if (!fbMarkets[localMarketId] || fbMarkets[localMarketId].type !== 'otc') {
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

// --- সংশোধিত মেইন ইঞ্জিন ---
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        if (!marketData || !marketData.history || marketData.history.length === 0) return;

        let lastCandle = marketData.history[marketData.history.length - 1];

        // ১. গাণিতিক ভুল সংশোধন: নিখুঁতভাবে টাইম গ্যাপ পূরণ
        const timeDiff = currentPeriod - lastCandle.timestamp;
        if (timeDiff >= TIMEFRAME) {
            const missingCandlesCount = Math.floor(timeDiff / TIMEFRAME);
            let currentGenTime = lastCandle.timestamp;
            
            for (let i = 0; i < missingCandlesCount; i++) {
                currentGenTime += TIMEFRAME; // প্রতিবার ঠিক ১ মিনিট যোগ হবে (ভবিষ্যতে যাওয়ার সুযোগ নেই)
                
                let newCandle;
                if (currentGenTime < currentPeriod) {
                    // পিছনের মিস হওয়া ক্যান্ডেলগুলো র‍্যান্ডম তৈরি হবে
                    newCandle = generateCandle(currentGenTime, lastCandle.close);
                } else {
                    // বর্তমান লাইভ ক্যান্ডেলটি শূন্য থেকে শুরু হবে
                    newCandle = {
                        timestamp: currentGenTime,
                        open: lastCandle.close,
                        high: lastCandle.close,
                        low: lastCandle.close,
                        close: lastCandle.close
                    };
                }

                marketData.history.push(newCandle);
                if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
                lastCandle = newCandle;
            }
            
            marketData.currentPrice = lastCandle.open;

            // অ্যাডমিন কন্ট্রোল এবং নতুন টার্গেট প্রাইস সেট করা
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

        // ২. স্মুথ লাইভ প্রাইস মুভমেন্ট
        let distance = marketData.targetPrice - marketData.currentPrice;
        let step = distance * 0.08;
        let maxAllowedStep = lastCandle.open * 0.00003;
        if (Math.abs(step) > maxAllowedStep) step = Math.sign(step) * maxAllowedStep;
        
        marketData.currentPrice += step;
        let jitter = (Math.random() - 0.5) * 0.00001 * lastCandle.open;
        
        lastCandle.close = parseFloat((marketData.currentPrice + jitter).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        // ক্লায়েন্টদের আপডেট পাঠানো
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ market: marketId, candle: lastCandle }));
            }
        });
    });
}, 200);

// API Endpoint (কোনো গ্যাপ পূরণের দরকার নেই, মেইন ইঞ্জিনই সব করে নেবে)
app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json([]); 
    }
});

app.get('/ping', (req, res) => res.send("UltraSmooth V6 - Final Perfect Timeline"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server v6 on ${PORT}`));