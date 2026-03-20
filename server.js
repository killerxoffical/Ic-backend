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

// ফায়ারবেস ইনিশিয়ালাইজ (যদি আগে না হয়ে থাকে)
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000; // ১ মিনিট
const markets = {};

// ক্যান্ডেল জেনারেটর (ন্যাচারাল লুকের জন্য)
function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        let diff = (Math.random() - 0.5) * 0.002 * startPrice;
        let close = open + diff;
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

// অ্যাডমিন কমান্ড স্টোরেজ
const adminOverrides = {};
const adminPatterns = {};

// ফায়ারবেস থেকে কমান্ড শোনা (Real-time Sync)
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

// 🟢 মেইন ইঞ্জিন: প্রতি ২০০ মিলিসেকেন্ডে চার্ট আপডেট
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        let history = marketData.history;
        let lastCandle = history[history.length - 1];

        // ১ মিনিট পার হলে নতুন ক্যান্ডেল শুরু করা
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

            // অ্যাডমিন কমান্ড চেক করা
            let forceDir = null;

            // ১. কুইক ওভাররাইড বা ড্রপডাউন প্যাটার্ন চেক
            if (adminOverrides[marketId]) {
                forceDir = adminOverrides[marketId].type;
                delete adminOverrides[marketId];
                db.ref(`admin/market_overrides/${marketId}`).remove();
            } 
            // ২. সিকোয়েন্স (Build Sequence) চেক
            else if (adminPatterns[marketId] && adminPatterns[marketId].isActive) {
                const config = adminPatterns[marketId];
                const index = Math.floor((currentPeriod - config.startTime) / (config.timeframe * 1000));
                if (index >= 0 && index < config.pattern.length) {
                    forceDir = config.pattern[index];
                } else if (index >= config.pattern.length) {
                    db.ref(`admin/markets/${marketId}/pattern_config/isActive`).set(false);
                }
            }

            // 🛠️ কাস্টম আর্কিটেক্ট লজিক (Slider Design)
            if (forceDir && forceDir.startsWith('PATTERN_CUSTOM_')) {
                const p = forceDir.split('_'); 
                const color = p[2];
                const upWick = parseInt(p[3]);
                const body = parseInt(p[4]);
                const lowWick = parseInt(p[5]);
                const totalScale = lastCandle.open * 0.0015;

                if (color === 'GREEN') {
                    lastCandle.close = lastCandle.open + (totalScale * (body / 100));
                    lastCandle.high = lastCandle.close + (totalScale * (upWick / 100));
                    lastCandle.low = lastCandle.open - (totalScale * (lowWick / 100));
                } else {
                    lastCandle.close = lastCandle.open - (totalScale * (body / 100));
                    lastCandle.high = lastCandle.open + (totalScale * (upWick / 100));
                    lastCandle.low = lastCandle.close - (totalScale * (lowWick / 100));
                }
                marketData.targetPrice = lastCandle.close;
                marketData.currentPrice = lastCandle.open;
            } 
            else {
                // 🛠️ অ্যাডমিন প্যানেলের ২৭-২৮টি প্যাটার্ন হ্যান্ডেল করার লজিক
                let baseMove = (Math.random() * 0.0012 + 0.0006) * lastCandle.open;
                
                const bullish = [
                    'UP', 'GREEN', 'PATTERN_HAMMER', 'PATTERN_INVERTED_HAMMER', 
                    'PATTERN_MARUBOZU_GREEN', 'PATTERN_BULLISH_ENGULFING', 
                    'PATTERN_BULLISH_HARAMI', 'PATTERN_PIERCING_LINE', 
                    'PATTERN_TWEEZER_BOTTOM', 'PATTERN_MORNING_STAR', 
                    'PATTERN_THREE_WHITE_SOLDIERS', 'PATTERN_THREE_INSIDE_UP', 
                    'PATTERN_THREE_OUTSIDE_UP'
                ];

                const bearish = [
                    'DOWN', 'RED', 'PATTERN_HANGING_MAN', 'PATTERN_SHOOTING_STAR', 
                    'PATTERN_MARUBOZU_RED', 'PATTERN_BEARISH_ENGULFING', 
                    'PATTERN_BEARISH_HARAMI', 'PATTERN_DARK_CLOUD_COVER', 
                    'PATTERN_TWEEZER_TOP', 'PATTERN_EVENING_STAR', 
                    'PATTERN_THREE_BLACK_CROWS', 'PATTERN_THREE_INSIDE_DOWN', 
                    'PATTERN_THREE_OUTSIDE_DOWN'
                ];

                const neutral = [
                    'PATTERN_DOJI', 'PATTERN_DRAGONFLY_DOJI', 
                    'PATTERN_GRAVESTONE_DOJI', 'PATTERN_LONG_LEGGED_DOJI', 
                    'PATTERN_SPINNING_TOP'
                ];

                if (bullish.includes(forceDir)) {
                    marketData.targetPrice = lastCandle.open + baseMove;
                } else if (bearish.includes(forceDir)) {
                    marketData.targetPrice = lastCandle.open - baseMove;
                } else if (neutral.includes(forceDir)) {
                    marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.0001;
                } else {
                    marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.0015 * lastCandle.open;
                }
            }
        }

        // 🟢 স্মুথ অ্যানিমেশন (প্রাইস ইন্টারপোলেশন)
        marketData.currentPrice += (marketData.targetPrice - marketData.currentPrice) * 0.12;
        lastCandle.close = parseFloat(marketData.currentPrice.toFixed(5));
        
        // হাই এবং লো আপডেট (যাতে শেপ ঠিক থাকে)
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        // লাইভ ব্রডকাস্ট
        const liveData = JSON.stringify({ market: marketId, candle: lastCandle });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) client.send(liveData);
        });
    });
}, 200);

// API: চার্ট হিস্ট্রি ফেচ
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (!markets[market]) {
        let startPrice = 1.15000 + (Math.random() * 0.1);
        markets[market] = generateInitialCandles(startPrice, MAX_CANDLES);
        console.log(`Initialized: ${market}`);
    }
    res.json(markets[market].history.slice(-500));
});

app.get('/ping', (req, res) => res.send("System Active"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`ICTEX Server running on port ${PORT}`);
});