const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000; // ১ মিনিট
const markets = {};

// আগের ক্যান্ডেলগুলো যেন রিয়েল মনে হয়, তার জন্য ন্যাচারাল সাইজ
function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        let body = (Math.random() - 0.5) * 0.00500 * startPrice; // Realistic body size
        let close = open + body;
        let high = Math.max(open, close) + (Math.random() * 0.00200 * startPrice);
        let low = Math.min(open, close) - (Math.random() * 0.00200 * startPrice);
        
        candles.push({
            timestamp: now - (i * TIMEFRAME),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            close: parseFloat(close.toFixed(5))
        });
        currentPrice = close;
    }
    return {
        history: candles,
        targetPrice: currentPrice,
        currentPrice: currentPrice
    };
}

// 🟢 ম্যাজিক লজিক: প্রতি ২০০ মিলিসেকেন্ডে (0.2s) স্মুথ আপডেট!
setInterval(() => {
    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let marketData = markets[marketId];
        let history = marketData.history;
        let lastCandle = history[history.length - 1];

        // ১ মিনিট পার হলে নতুন ক্যান্ডেল
        if (now > lastCandle.timestamp) {
            let newCandle = {
                timestamp: now,
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            history.push(newCandle);
            if (history.length > MAX_CANDLES) history.shift();
            lastCandle = newCandle;
            
            // নতুন ক্যান্ডেলের জন্য নতুন টার্গেট প্রাইস
            marketData.targetPrice = lastCandle.open + (Math.random() - 0.5) * 0.00500 * lastCandle.open;
        }

        // মাঝে মাঝে রেন্ডমলি প্রাইসের ডিরেকশন চেঞ্জ হবে (রিয়েলিস্টিক ফিল)
        if (Math.random() < 0.1) {
            marketData.targetPrice = lastCandle.close + (Math.random() - 0.5) * 0.00300 * lastCandle.close;
        }

        // 🟢 স্মুথ অ্যানিমেশন লজিক: বর্তমান প্রাইসকে ধীরে ধীরে টার্গেটের দিকে টানা
        marketData.currentPrice += (marketData.targetPrice - marketData.currentPrice) * 0.15;
        
        // রিয়েল টিক (Tick) ভাইব্রেশন তৈরি করা
        let noise = (Math.random() - 0.5) * 0.00020 * marketData.currentPrice;
        
        lastCandle.close = parseFloat((marketData.currentPrice + noise).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        const liveData = JSON.stringify({ market: marketId, candle: lastCandle });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(liveData);
            }
        });
    });
}, 200); // 200ms = 5 FPS (চোখের দেখায় একদম স্মুথ লাগবে)

// API Endpoint
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (!markets[market]) {
        let randomStartPrice = 1.15000 + (Math.random() * 0.10000); // Forex style pricing (যেমন: 1.15432)
        markets[market] = generateInitialCandles(randomStartPrice, MAX_CANDLES);
        console.log(`Created new market data for: ${market}`);
    }
    res.json(markets[market].history.slice(-500)); 
});

app.get('/ping', (req, res) => {
    res.send("Server is awake!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`OTC Server is running on port ${PORT}`);
});