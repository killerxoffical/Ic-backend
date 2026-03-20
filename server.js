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

// --- রিয়েল ক্যান্ডেল জেনারেটর (ন্যাচারাল শ্যাডো সহ) ---
function generateHistoricalCandle(timestamp, open) {
    let isGreen = Math.random() > 0.5;
    let body = (Math.random() * 0.0004) * open;
    let close = isGreen ? open + body : open - body;
    
    let upperWick = (Math.random() * 0.0002) * open;
    let lowerWick = (Math.random() * 0.0002) * open;

    return {
        timestamp: timestamp,
        open: parseFloat(open.toFixed(5)),
        high: parseFloat((Math.max(open, close) + upperWick).toFixed(5)),
        low: parseFloat((Math.min(open, close) - lowerWick).toFixed(5)),
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
        if (lastCandle) startPrice = lastCandle.close;
    }
    
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = 300; i > 0; i--) {
        const newCandle = generateHistoricalCandle(now - (i * TIMEFRAME), currentPrice);
        candles.push(newCandle);
        currentPrice = newCandle.close;
    }

    markets[marketId] = {
        history: candles,
        currentPrice: currentPrice,
        targetPrice: currentPrice,
        tickCount: 0 // নতুন: জিগ-জ্যাগ মুভমেন্টের জন্য
    };
}

// ফায়ারবেস মার্কেট সিঙ্ক
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

// --- সংশোধিত মেইন ইঞ্জিন (রিয়েলিস্টিক প্রাইস অ্যাকশন) ---
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        if (!marketData || !marketData.history || marketData.history.length === 0) return;

        let lastCandle = marketData.history[marketData.history.length - 1];

        // ১. টাইম গ্যাপ পূরণ
        const timeDiff = currentPeriod - lastCandle.timestamp;
        if (timeDiff >= TIMEFRAME) {
            const missingCandlesCount = Math.floor(timeDiff / TIMEFRAME);
            let currentGenTime = lastCandle.timestamp;
            
            for (let i = 0; i < missingCandlesCount; i++) {
                currentGenTime += TIMEFRAME;
                let newCandle;
                if (currentGenTime < currentPeriod) {
                    newCandle = generateHistoricalCandle(currentGenTime, lastCandle.close);
                } else {
                    newCandle = {
                        timestamp: currentGenTime, open: lastCandle.close,
                        high: lastCandle.close, low: lastCandle.close, close: lastCandle.close
                    };
                }
                marketData.history.push(newCandle);
                if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
                lastCandle = newCandle;
            }
            marketData.currentPrice = lastCandle.open;
            marketData.targetPrice = lastCandle.open;
            marketData.tickCount = 10; // সাথে সাথে নতুন টার্গেট নিবে
        }

        // ২. নতুন জিগ-জ্যাগ লজিক (প্রতি ২ সেকেন্ডে টার্গেট বদলাবে)
        if (!marketData.tickCount) marketData.tickCount = 0;
        marketData.tickCount++;

        if (marketData.tickCount >= 10 || !marketData.targetPrice) {
            marketData.tickCount = 0; // রিস্টার্ট টাইমার
            
            let forceDir = null;
            if (adminOverrides[marketId] && adminOverrides[marketId].timestamp > Date.now() - (60 * 1000)) {
                forceDir = adminOverrides[marketId].type;
            } else if (adminPatterns[marketId] && adminPatterns[marketId].isActive) {
                const config = adminPatterns[marketId];
                const index = Math.floor((currentPeriod - config.startTime) / (config.timeframe * 1000));
                if (index >= 0 && index < config.pattern.length) forceDir = config.pattern[index];
            }

            let baseVolatility = lastCandle.open * 0.00015;

            if (forceDir && forceDir.startsWith('PATTERN_CUSTOM_')) {
                const p = forceDir.split('_');
                const body = parseInt(p[4]) || 40;
                const totalScale = lastCandle.open * 0.0009;
                marketData.targetPrice = (p[2] === 'GREEN') 
                    ? lastCandle.open + (totalScale * (body / 100)) 
                    : lastCandle.open - (totalScale * (body / 100));
            } else if (['UP', 'GREEN'].includes(forceDir)) {
                // উপরে যাবে, কিন্তু একটু কাঁপতে কাঁপতে
                marketData.targetPrice = marketData.currentPrice + (Math.random() * baseVolatility * 1.5) - (baseVolatility * 0.2);
            } else if (['DOWN', 'RED'].includes(forceDir)) {
                // নিচে যাবে, কিন্তু একটু কাঁপতে কাঁপতে
                marketData.targetPrice = marketData.currentPrice - (Math.random() * baseVolatility * 1.5) + (baseVolatility * 0.2);
            } else {
                // একদম রিয়েল ন্যাচারাল মার্কেট (Zig-Zag)
                let randomMove = (Math.random() - 0.5) * baseVolatility * 2.5;
                // মার্কেট যেন একদিকে হারিয়ে না যায় তার জন্য রিকভারি সিস্টেম
                let distanceToOpen = marketData.currentPrice - lastCandle.open;
                let meanReversion = -distanceToOpen * 0.1; 
                marketData.targetPrice = marketData.currentPrice + randomMove + meanReversion;
            }
        }

        // ৩. স্মুথ মুভমেন্ট (Smooth Transition)
        let distance = marketData.targetPrice - marketData.currentPrice;
        let step = distance * 0.15; // প্রতি টিক-এ ১৫% এগোবে
        
        marketData.currentPrice += step;
        let jitter = (Math.random() - 0.5) * 0.000008 * lastCandle.open; // মাইক্রো কাঁপুনি
        
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

app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json([]); 
    }
});

app.get('/ping', (req, res) => res.send("UltraSmooth V7 - ZigZag Engine"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Ultra Smooth Server v7 on ${PORT}`));