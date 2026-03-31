// --- START: FULLY UPDATED server.js (v16-Final Fixed) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// 🔥 আপনার নতুন ফায়ারবেস প্রজেক্টের কনফিগারেশন
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

const MAX_CANDLES_IN_RAM = 3000;
const TIMEFRAME = 60000; // 1 minute candles
const TICK_MS = 200; // 🔥 প্রতি ২০০ মিলিসেকেন্ডে চার্ট আপডেট (সুপার স্মুথ)
const FIREBASE_BACKUP_INTERVAL = 60000; // 🔥 প্রতি ১ মিনিটে একবার ফায়ারবেসে ব্যাকআপ
const HISTORY_SEED_COUNT = 300;

const markets = {}; // সার্ভারের র‍্যামে ক্যান্ডেলগুলো থাকবে

function roundPrice(v) {
  return parseFloat(v.toFixed(5));
}

function marketPathFromId(marketId) {
  return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase();
}

function cloneCandle(c) {
  return { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

function generateHistoricalCandle(timestamp, open) {
  const safeOpen = Math.max(0.00001, open);
  const isGreen = Math.random() > 0.5;
  const body = (0.00006 + Math.random() * 0.00022) * safeOpen;
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

// 🔥 সার্ভার রিস্টার্ট হলে ফায়ারবেস থেকে আগের প্রাইস রিস্টোর করার ফাংশন
async function initializeNewMarket(marketId) {
  const path = marketPathFromId(marketId);
  let startPrice = 1.15;

  try {
    const liveSnap = await db.ref(`markets/${path}/live`).once('value');
    const lastLive = liveSnap.val();
    if (lastLive && lastLive.price) {
      startPrice = lastLive.price;
      console.log(`[Restored] ${marketId} from price: ${startPrice}`);
    }
  } catch (e) {
    console.error("Restore error:", e);
  }

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
    currentPrice: currentPrice
  };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    const missingCount = Math.floor((currentPeriod - lastCandle.timestamp) / TIMEFRAME);
    for (let i = 0; i < missingCount; i++) {
      const newTimestamp = lastCandle.timestamp + TIMEFRAME;
      const newCandle = {
        timestamp: newTimestamp,
        open: lastCandle.close,
        high: lastCandle.close,
        low: lastCandle.close,
        close: lastCandle.close
      };
      marketData.history.push(newCandle);
      if (marketData.history.length > MAX_CANDLES_IN_RAM) {
        marketData.history.shift();
      }
      lastCandle = newCandle;
    }
  }
  return lastCandle;
}

function updateCandlePrice(marketData, candle) {
  const volatility = 0.00015;
  let move = (Math.random() - 0.495) * (candle.open * volatility);
  
  // Mean reversion
  const meanReversionForce = (candle.open - marketData.currentPrice) * 0.01;
  move += meanReversionForce;

  marketData.currentPrice += move;
  candle.close = roundPrice(marketData.currentPrice);
  candle.high = roundPrice(Math.max(candle.high, candle.close));
  candle.low = roundPrice(Math.min(candle.low, candle.close));
}

// 🔥 ফায়ারবেস আপডেট
async function mirrorLivePriceToFirebase(marketData, candle) {
  try {
    await db.ref(`markets/${marketData.marketPath}/live`).set({
      price: candle.close,
      timestamp: candle.timestamp,
    });
  } catch (err) {}
}

// 🔥 ব্যান্ডউইথ সেভার
function broadcastCandle(marketId, candle) {
  const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
      client.send(payload);
    }
  });
}

// Admin / Market লিসেনার
db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((id) => {
    if (!markets[id] && fbMarkets[id].status === 'active' && (fbMarkets[id].type === 'otc' || fbMarkets[id].type === 'broker_real')) {
      initializeNewMarket(id);
    }
  });
});

wss.on('connection', (ws) => {
    ws.subscribedMarket = null;
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe' && msg.market) {
                ws.subscribedMarket = msg.market;
            }
        } catch(e) {}
    });
});


// 🔥 MAIN LOOP
setInterval(() => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

  for (const marketId in markets) {
    const marketData = markets[marketId];
    let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!candle) continue;

    updateCandlePrice(marketData, candle);
    broadcastCandle(marketId, candle);
  }
  
  // ফায়ারবেসে ব্যাকআপ (প্রতি ১ মিনিটে একবার)
  if (now % FIREBASE_BACKUP_INTERVAL < TICK_MS) {
      for (const marketId in markets) {
          const marketData = markets[marketId];
          const lastCandle = marketData.history[marketData.history.length-1];
          if(lastCandle) mirrorLivePriceToFirebase(marketData, lastCandle);
      }
      console.log(`[Firebase Backup] Synced live prices.`);
  }

}, TICK_MS);


// API routes
app.get('/api/history/:market', (req, res) => {
  const marketData = markets[req.params.market];
  if (!marketData) return res.status(404).json([]);
  res.json(marketData.history.map(cloneCandle));
});

// 🔥 CRITICAL FIX: Cron Job এর জন্য এই রুটটি যোগ করা হলো
app.get('/ping', (_req, res) => {
  res.send('UltraSmooth V16-Final active');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server v16-Final active on ${PORT}`));

// --- END: FULLY UPDATED server.js ---