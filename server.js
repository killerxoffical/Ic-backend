const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ১০০টি মার্কেট এবং ৫০০০ ক্যান্ডেল সেটআপ
const MAX_CANDLES = 5000;
const TIMEFRAME = 60000; // ১ মিনিট (60,000 ms)
const markets = {};

// ডেমো ১০০টি মার্কেট তৈরি করা হচ্ছে
for (let i = 1; i <= 100; i++) {
    markets[`OTC-MARKET-${i}`] = generateInitialCandles(100.00, MAX_CANDLES);
}

// শুরুতে কিছু ফেক ক্যান্ডেল তৈরি করার ফাংশন
function generateInitialCandles(startPrice, count) {
    let candles = [];
    let currentPrice = startPrice;
    let now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    for (let i = count; i > 0; i--) {
        let open = currentPrice;
        let close = open + (Math.random() - 0.5) * 2;
        let high = Math.max(open, close) + Math.random();
        let low = Math.min(open, close) - Math.random();
        
        candles.push({
            timestamp: now - (i * TIMEFRAME),
            open: parseFloat(open.toFixed(5)),
            high: parseFloat(high.toFixed(5)),
            low: parseFloat(low.toFixed(5)),
            close: parseFloat(close.toFixed(5))
        });
        currentPrice = close;
    }
    return candles;
}

// প্রতি ১ সেকেন্ডে মার্কেট আপডেট করার লজিক
setInterval(() => {
    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let history = markets[marketId];
        let lastCandle = history[history.length - 1];

        // যদি ১ মিনিট পার হয়ে যায়, নতুন ক্যান্ডেল শুরু করো
        if (now > lastCandle.timestamp) {
            let newCandle = {
                timestamp: now,
                open: lastCandle.close,
                high: lastCandle.close,
                low: lastCandle.close,
                close: lastCandle.close
            };
            history.push(newCandle);
            if (history.length > MAX_CANDLES) history.shift(); // ৫০০০ এর বেশি হলে পুরনোটা ডিলিট
            lastCandle = newCandle;
        }

        // লাইভ প্রাইস ওঠানামা করানো
        let priceChange = (Math.random() - 0.5) * 0.5;
        lastCandle.close = parseFloat((lastCandle.close + priceChange).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        // WebSockets দিয়ে সব ইউজারকে লাইভ আপডেট পাঠানো
        const liveData = JSON.stringify({ market: marketId, candle: lastCandle });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(liveData);
            }
        });
    });
}, 1000); // প্রতি ১ সেকেন্ডে আপডেট

// API Endpoint - ইউজার অ্যাপে ঢুকলে এই লিংকে হিট করে হিস্ট্রি নেবে
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    if (markets[market]) {
        // একসাথে ৫০০০ না পাঠিয়ে শেষের ৫০০ ক্যান্ডেল পাঠাবে (Fast Load)
        res.json(markets[market].slice(-500)); 
    } else {
        res.status(404).json({ error: "Market not found" });
    }
});

// Uptime/Cron-job এর জন্য Ping Endpoint (সার্ভার সজাগ রাখার জন্য)
app.get('/ping', (req, res) => {
    res.send("Server is awake!");
});

// সার্ভার চালু করা
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`OTC Server is running on port ${PORT}`);
});