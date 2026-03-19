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

// ক্যান্ডেল তৈরি করার ফাংশন
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

// প্রতি সেকেন্ডে প্রাইস আপডেট
setInterval(() => {
    const now = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;

    Object.keys(markets).forEach(marketId => {
        let history = markets[marketId];
        let lastCandle = history[history.length - 1];

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
        }

        let priceChange = (Math.random() - 0.5) * 0.5;
        lastCandle.close = parseFloat((lastCandle.close + priceChange).toFixed(5));
        lastCandle.high = Math.max(lastCandle.high, lastCandle.close);
        lastCandle.low = Math.min(lastCandle.low, lastCandle.close);

        const liveData = JSON.stringify({ market: marketId, candle: lastCandle });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(liveData);
            }
        });
    });
}, 1000);

// API Endpoint - স্মার্ট মার্কেট জেনারেটর (ম্যাজিক এখানেই!)
app.get('/api/history/:market', (req, res) => {
    const market = req.params.market;
    
    // যদি সার্ভারে এই মার্কেট না থাকে, তবে সাথে সাথে নতুন করে বানিয়ে নেবে!
    if (!markets[market]) {
        let randomStartPrice = 50 + (Math.random() * 400); // 50 থেকে 500 এর মধ্যে রেন্ডম প্রাইস
        markets[market] = generateInitialCandles(randomStartPrice, MAX_CANDLES);
        console.log(`Created new market data for: ${market}`);
    }
    
    // শেষের ৫০০ ক্যান্ডেল অ্যাপে পাঠাবে (Fast Load এর জন্য)
    res.json(markets[market].slice(-500)); 
});

app.get('/ping', (req, res) => {
    res.send("Server is awake!");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`OTC Server is running on port ${PORT}`);
});