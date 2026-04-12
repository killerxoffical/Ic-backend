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

const MAX_CANDLES = 500;
const TIMEFRAME = 60000;
const TICK_MS = 250;
const MIN_PRICE = 0.00001;

const markets = {}; 
let pendingCommands = {}; // কমান্ড এখানে এসে অপেক্ষা করবে

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }

// ফায়ারবেস থেকে কমান্ড রিসিভ করা
db.ref('admin/pending_patterns').on('value', (snapshot) => {
    pendingCommands = snapshot.val() || {};
});

// 🎯 ১. টার্গেট OHLC জেনারেটর 🎯
function generateTargetOHLC(openPrice, pattern) {
    const vol = openPrice * 0.00015; // মার্কেটের সাধারণ ভলিউম
    let O = openPrice, C, H, L;
    
    switch(pattern) {
        case 'MARUBOZU_GREEN':
            C = O + (vol * 4); H = C; L = O; break;
        case 'MARUBOZU_RED':
            C = O - (vol * 4); H = O; L = C; break;
            
        case 'HAMMER_GREEN': // নিচে লম্বা লেজ, উপরে ছোট বডি
            C = O + (vol * 1); H = C + (vol * 0.2); L = O - (vol * 5); break;
        case 'HAMMER_RED': // নিচে লম্বা লেজ, উপরে ছোট লাল বডি
            C = O - (vol * 1); H = O + (vol * 0.2); L = C - (vol * 5); break;
            
        case 'SHOOTING_STAR_GREEN': // উপরে লম্বা লেজ, নিচে ছোট বডি
            C = O + (vol * 1); H = C + (vol * 5); L = O - (vol * 0.2); break;
        case 'SHOOTING_STAR_RED': // উপরে লম্বা লেজ, নিচে ছোট লাল বডি
            C = O - (vol * 1); H = O + (vol * 5); L = C - (vol * 0.2); break;
            
        case 'DOJI_GREEN': // ওপেন এবং ক্লোজ প্রায় সমান, দুইদিকে লেজ
            C = O + (vol * 0.1); H = O + (vol * 3); L = O - (vol * 3); break;
        case 'DOJI_RED': // ওপেন এবং ক্লোজ প্রায় সমান, দুইদিকে লেজ
            C = O - (vol * 0.1); H = O + (vol * 3); L = O - (vol * 3); break;
            
        default: // NORMAL (Random)
            let isUp = Math.random() > 0.5;
            let body = vol * (0.5 + Math.random());
            C = isUp ? O + body : O - body;
            H = Math.max(O, C) + (vol * Math.random() * 2);
            L = Math.min(O, C) - (vol * Math.random() * 2);
            pattern = 'NORMAL';
    }
    return { open: roundPrice(O), high: roundPrice(H), low: roundPrice(L), close: roundPrice(C), pattern };
}

// 🎯 ২. রিয়েলিস্টিক অ্যানিমেশন রুট (Waypoint Engine) 🎯
function calculateCurrentPrice(target, progress) {
    const { open: O, high: H, low: L, close: C, pattern } = target;
    let basePrice;

    if (pattern.includes('HAMMER')) {
        // প্রথমে Low তে যাবে, তারপর Close এ উঠবে
        if (progress < 0.5) basePrice = O + (L - O) * (progress / 0.5);
        else basePrice = L + (C - L) * ((progress - 0.5) / 0.5);
    } 
    else if (pattern.includes('SHOOTING_STAR')) {
        // প্রথমে High তে যাবে, তারপর Close এ নামবে
        if (progress < 0.5) basePrice = O + (H - O) * (progress / 0.5);
        else basePrice = H + (C - H) * ((progress - 0.5) / 0.5);
    }
    else if (pattern.includes('DOJI')) {
        // High -> Low -> Close
        if (progress < 0.33) basePrice = O + (H - O) * (progress / 0.33);
        else if (progress < 0.66) basePrice = H + (L - H) * ((progress - 0.33) / 0.33);
        else basePrice = L + (C - L) * ((progress - 0.66) / 0.34);
    }
    else {
        // NORMAL বা MARUBOZU (সরাসরি ওপেন থেকে ক্লোজ)
        basePrice = O + (C - O) * progress;
    }

    // হালকা কাঁপুনি (Noise) যোগ করা যাতে রোবোটিক না লাগে
    const noiseAllowed = Math.abs(H - L) * 0.15 * (1 - progress);
    let finalPrice = basePrice + ((Math.random() - 0.5) * noiseAllowed);

    // লিমিটের বাইরে যেন না যায়
    finalPrice = Math.max(L, Math.min(H, finalPrice));
    
    // একদম শেষে (59 সেকেন্ডে) ক্লোজ প্রাইসে ফিক্সড করে দেওয়া
    if (progress >= 0.98) finalPrice = C;

    return finalPrice;
}


async function initializeNewMarket(marketId) {
    const path = marketId.replace(/[\.\/ ]/g, '-').toLowerCase();
    let startPrice = 1.15;
    try { const liveSnap = await db.ref(`markets/${path}/live`).once('value'); if (liveSnap.val()?.price) startPrice = liveSnap.val().price; } catch (e) {}

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let currentPrice = startPrice;

    for (let i = 300; i > 0; i--) {
        const p = generateTargetOHLC(currentPrice, 'NORMAL');
        candles.push({ timestamp: nowPeriod - (i * TIMEFRAME), open: p.open, high: p.high, low: p.low, close: p.close });
        currentPrice = p.close;
    }
    markets[marketId] = { marketId, marketPath: path, history: candles, target: null };
}

function processMarketTick(marketData, currentPeriod) {
    let lastCandle = marketData.history[marketData.history.length - 1];

    // নতুন মিনিট শুরু হলে
    if (!marketData.target || marketData.target.timestamp !== currentPeriod) {
        let openPrice = lastCandle ? lastCandle.close : 1.15;
        let selectedPattern = 'NORMAL';

        // চেক করুন অ্যাডমিন কোনো কমান্ড দিয়ে রেখেছে কি না
        if (pendingCommands[marketData.marketId]) {
            selectedPattern = pendingCommands[marketData.marketId];
            console.log(`[ADMIN] Executing ${selectedPattern} on ${marketData.marketId}`);
            
            // কমান্ডটি ফায়ারবেস থেকে মুছে দিন, যাতে এটি শুধু একবারই কাজ করে
            db.ref(`admin/pending_patterns/${marketData.marketId}`).remove();
        }

        // টার্গেট জেনারেট করা
        marketData.target = { timestamp: currentPeriod, ...generateTargetOHLC(openPrice, selectedPattern) };
        
        // নতুন ক্যান্ডেল পুশ করা
        marketData.history.push({ timestamp: currentPeriod, open: openPrice, high: openPrice, low: openPrice, close: openPrice });
        if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        
        lastCandle = marketData.history[marketData.history.length - 1];
    }

    // প্রাইস আপডেট করা
    const timeElapsed = Date.now() - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 
    
    const newPrice = calculateCurrentPrice(marketData.target, progress);

    lastCandle.close = roundPrice(newPrice);
    lastCandle.high = roundPrice(Math.max(lastCandle.high, newPrice));
    lastCandle.low = roundPrice(Math.min(lastCandle.low, newPrice));
}

function broadcastCandle(marketId, candle) {
    const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
    wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.subscribedMarket === marketId) c.send(payload); });
}

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => { if ((fbMarkets[marketId]?.type === 'otc' || fbMarkets[marketId]?.type === 'broker_real') && !markets[marketId]) initializeNewMarket(marketId); });
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                if (markets[msg.market]) ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) }));
            }
        } catch (_) {}
    });
});

app.get('/api/history/:marketId', (req, res) => {
    if (markets[req.params.marketId]) {
        res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=60'); // Cloudflare Cache
        res.json(markets[req.params.marketId].history.slice(-300));
    } else res.status(404).json({ error: 'Market not found' });
});

setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

    for (const marketId in markets) {
        processMarketTick(markets[marketId], currentPeriod);
        broadcastCandle(marketId, markets[marketId].history[markets[marketId].history.length - 1]);
    }
}, TICK_MS);

setInterval(() => {
    const batchUpdates = {};
    for (const marketId in markets) {
        const lastC = markets[marketId].history[markets[marketId].history.length-1];
        if (lastC) batchUpdates[`markets/${markets[marketId].marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
    }
    db.ref().update(batchUpdates).catch(()=>{});
}, 60000);

app.get('/ping', (_req, res) => res.send('Pattern Injector Active'));
server.listen(process.env.PORT || 3000, () => console.log(`Server started`));