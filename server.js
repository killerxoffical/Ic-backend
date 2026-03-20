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

// ক্যান্ডেল জেনারেটর (অত্যন্ত স্থিতিশীল লজিক)
function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        // মুভমেন্ট খুব ছোট রাখা হয়েছে (০.০৫% এর নিচে)
        let diff = (Math.random() - 0.5) * 0.0005 * startPrice;
        let close = open + diff;
        candles.push({
            timestamp: now - (i * TIMEFRAME),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(Math.max(open, close + Math.random() * 0.0002 * startPrice).toFixed(5)),
            low: parseFloat(Math.min(open, close - Math.random() * 0.0002 * startPrice).toFixed(5)),
            close: parseFloat(close.toFixed(5))
        });
        currentPrice = close;
    }
    return { history: candles, currentPrice: currentPrice, targetPrice: currentPrice };
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

// 🟢 মেইন ইঞ্জিন: স্পাইক কন্ট্রোল লজিকসহ
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
                } else if (index >= config.pattern.length) {
                    db.ref(`admin/markets/${marketId}/pattern_config/isActive`).set(false);
                }
            }

            // 🛠️ মুভমেন্ট রেঞ্জ ছোট করা হয়েছে যাতে গ্রাফ লাফ না দেয়
            let baseMove = (Math.random() * 0.0006 + 0.0002) * lastCandle.open;
            
            const bullish = ['UP', 'GREEN', 'PATTERN_HAMMER', 'PATTERN_MARUBOZU_GREEN', 'PATTERN_BULLISH_ENGULFING', 'PATTERN_MORNING_STAR', 'PATTERN_THREE_WHITE_SOLDIERS', 'PATTERN_BULLISH_HARAMI', 'PATTERN_PIERCING_LINE', 'PATTERN_TWEEZER_BOTTOM', 'PATTERN_THREE_INSIDE_UP', 'PATTERN_THREE_OUTSIDE_UP', 'PATTERN_INVERTED_HAMMER'];
            const bearish = ['DOWN', 'RED', 'PATTERN_HANGING_MAN', 'PATTERN_SHOOTING_STAR', 'PATTERN_MARUBOZU_RED', 'PATTERN_BEARISH_ENGULFING', 'PATTERN_EVENING_STAR', 'PATTERN_THREE_BLACK_CROWS', 'PATTERN_BEARISH_HARAMI', 'PATTERN_DARK_CLOUD_COVER', 'PATTERN_TWEEZER_TOP', 'PATTERN_THREE_INSIDE_DOWN', 'PATTERN_THREE_OUTSIDE_DOWN'];
            const neutral = ['PATTERN_DOJI', 'PATTERN_DRAGONFLY_DOJI', 'PATTERN_GRAVESTONE_DOJI', 'PATTERN_LONG_LEGGED_DOJI', 'PATTERN_SPINNING_TOP'];

            if (forceDir && forceDir.startsWith('PATTERN_CUSTOM_')) {
                const p = forceDir.split('_'); 
                const color = p[2];
                const body = parseInt(p[4]);
                // আর্কিটেক্টের জন্য মুভমেন্ট লিমিটেড করা হয়েছে
                const totalScale = lastCandle.open * 0.0008; 

                if (color === 'GREEN') {
                    marketData.targetPrice = lastCandle.open + (totalScale * (body / 100));
                } else {
                    marketData.targetPrice = lastCandle.open - (totalScale * (body / 100));
                }
                marketData.currentPrice = lastCandle.open;
            } 
            else if (bullish.includes(forceDir)) {
                marketData.targetPrice = lastCandle.open + baseMove;
            } else if (bearish.includes(forceDir)) {
                marketData.targetPrice = lastCandle.open - baseMove;
            } else if (neutral.includes(forceDir)) {
                marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.00005;
            } else {
                // সাধারণ সময়ে মুভমেন্ট আরও ছোট (০.০১% এর আশেপাশে)
                marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.0005 * lastCandle.open;
            }
        }

        // 🟢 স্পাইক প্রিভেনশন: এক লাফে প্রাইস মুভমেন্ট সীমিত করা
        let diff = marketData.targetPrice - marketData.currentPrice;
        let maxStep = lastCandle.open * 0.0001; // প্রতি ২০০ মিলিসেকেন্ডে ০.০১% এর বেশি মুভ করতে পারবে না
        
        if (Math.abs(diff) > maxStep) {
            marketData.currentPrice += Math.sign(diff) * maxStep;
        } else {
            marketData.currentPrice += diff * 0.15;
        }
        
        lastCandle.close = parseFloat(marketData.currentPrice.toFixed(5));
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
        let startPrice = 1.15000 + (Math.random() * 0.05);
        markets[market] = generateInitialCandles(startPrice, MAX_CANDLES);
    }
    res.json(markets[market].history.slice(-500));
});

app.get('/ping', (req, res) => res.send("Stable"));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Stable Server on ${PORT}`));