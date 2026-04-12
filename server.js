// --- START: server.js (v22 - With 5-Minute Future Market Logic) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// Firebase Configuration
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

const MAX_CANDLES = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;
const FUTURE_DELAY_MS = 5 * 60 * 1000; // 5 Minutes Future Delay

const markets = {}; 
const adminPatterns = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId]; 
        }
    });
});

// Normal OTC Candle
function generateHistoricalCandle(timestamp, open) {
  const safeOpen = Math.max(MIN_PRICE, open);
  const isGreen = Math.random() > 0.5;
  const body = (0.00006 + Math.random() * 0.00025) * safeOpen;
  const close = isGreen ? safeOpen + body : safeOpen - body;
  const upperWick = (0.00003 + Math.random() * 0.00015) * safeOpen;
  const lowerWick = (0.00003 + Math.random() * 0.00015) * safeOpen;

  return { timestamp, open: roundPrice(safeOpen), high: roundPrice(Math.max(safeOpen, close) + upperWick), low: roundPrice(Math.min(safeOpen, close) - lowerWick), close: roundPrice(close) };
}

// Cubic Bezier Interpolation for Smooth Future Ticking
function interpolatePrice(candle, progress) {
    const p0 = candle.open;
    const p3 = candle.close;
    let p1, p2;
    if (candle.close >= candle.open) { p1 = candle.low; p2 = candle.high; }
    else { p1 = candle.high; p2 = candle.low; }
    const t = Math.max(0, Math.min(1, progress));
    return Math.pow(1 - t, 3) * p0 + 3 * Math.pow(1 - t, 2) * t * p1 + 3 * (1 - t) * Math.pow(t, 2) * p2 + Math.pow(t, 3) * p3;
}

async function initializeNewMarket(marketId, type) {
  const path = marketPathFromId(marketId);
  let startPrice = 1.15;
  try {
    const liveSnap = await db.ref(`markets/${path}/live`).once('value');
    if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
  } catch (e) {}

  const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
  const candles =[];
  let currentPrice = startPrice;

  for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
    const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
    candles.push(c);
    currentPrice = c.close;
  }

  markets[marketId] = {
    marketId,
    marketPath: path,
    type: type,
    history: candles,
    currentPrice: currentPrice,
    futureQueue:[], // Used for Future Markets
    lastMove: 0
  };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    let newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close);
    marketData.history.push(newCandle);
    if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    return newCandle;
  }
  return lastCandle;
}

function updateRealisticPrice(marketData, candle) {
  if (Math.random() < 0.35) return; 
  const openPrice = candle.open;
  const baseVolatility = openPrice * 0.00005;
  let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
  let recoil = -marketData.lastMove * 0.3; 
  let jitter = (Math.random() - 0.5) * (baseVolatility * 0.2);
  let finalMove = impulse + recoil + jitter;
  if (Math.random() < 0.1) finalMove *= 4;
  marketData.currentPrice += finalMove;
  marketData.lastMove = finalMove;
  const dist = marketData.currentPrice - openPrice;
  if (Math.abs(dist) > openPrice * 0.001) marketData.currentPrice -= finalMove * 1.5;
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

db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((marketId) => {
    const type = fbMarkets[marketId]?.type;
    if ((type === 'otc' || type === 'broker_real' || type === 'future') && !markets[marketId]) {
      initializeNewMarket(marketId, type);
    }
  });
});

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg?.type === 'subscribe') {
        ws.subscribedMarket = msg.market;
        if (markets[msg.market]) {
            const historyPayload = { type: 'history', market: msg.market, candles: markets[msg.market].history.slice(-300) };
            ws.send(JSON.stringify(historyPayload));
        }
      }
    } catch (_) {}
  });
});

app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found' });
    }
});

// Main Loop
let lastSyncMinute = 0;
setInterval(() => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
  const currentMinute = Math.floor(now / 60000);

  for (const marketId in markets) {
    const m = markets[marketId];

    // --- NEW: FUTURE MARKET LOGIC ---
    if (m.type === 'future') {
        let lastFuture = m.futureQueue.length > 0 ? m.futureQueue[m.futureQueue.length - 1] : m.history[m.history.length - 1];
        
        // Generate up to 5 mins into the future
        while (lastFuture && lastFuture.timestamp < currentPeriod + FUTURE_DELAY_MS) {
            const nextTs = lastFuture.timestamp + TIMEFRAME;
            const newCandle = generateHistoricalCandle(nextTs, lastFuture.close);
            m.futureQueue.push(newCandle);
            lastFuture = newCandle;
        }

        // Get the target candle for the current exact time
        const targetCandle = m.futureQueue.find(c => c.timestamp === currentPeriod);
        if (targetCandle) {
            let liveCandle = m.history.find(c => c.timestamp === currentPeriod);
            if (!liveCandle) {
                liveCandle = { timestamp: currentPeriod, open: targetCandle.open, high: targetCandle.open, low: targetCandle.open, close: targetCandle.open };
                m.history.push(liveCandle);
                if (m.history.length > MAX_CANDLES) m.history.shift();
                m.futureQueue = m.futureQueue.filter(c => c.timestamp > currentPeriod); // Clean up passed futures
            }

            // Interpolate live ticking smoothly
            const progress = (now - currentPeriod) / TIMEFRAME;
            let currentLivePrice = interpolatePrice(targetCandle, progress);
            currentLivePrice += (Math.random() - 0.5) * (targetCandle.open * 0.00005); // Tiny noise
            
            liveCandle.close = roundPrice(currentLivePrice);
            liveCandle.high = roundPrice(Math.max(liveCandle.high, liveCandle.close));
            liveCandle.low = roundPrice(Math.min(liveCandle.low, liveCandle.close));

            broadcastCandle(marketId, liveCandle);
            m.currentPrice = liveCandle.close;
        }
    } 
    // --- NORMAL OTC LOGIC ---
    else {
        let candle = ensureCurrentPeriodCandle(m, currentPeriod);
        if (!candle) continue;
        updateRealisticPrice(m, candle);
        broadcastCandle(marketId, candle);
    }
  }

  // Backup to Firebase & Admin Future Sync
  if (currentMinute > lastSyncMinute) {
    lastSyncMinute = currentMinute;
    const batchUpdates = {};
    for (const marketId in markets) {
      const m = markets[marketId];
      const lastC = m.history[m.history.length-1];
      if (lastC) {
        batchUpdates[`markets/${m.marketPath}/live`] = { price: lastC.close, timestamp: lastC.timestamp };
      }
      if (m.type === 'future' && m.futureQueue.length > 0) {
        // Send the future prediction to admin panel
        batchUpdates[`admin/markets/${marketId}/future_data`] = m.futureQueue;
      }
    }
    db.ref().update(batchUpdates).catch(()=>{});
  }
}, TICK_MS);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UltraSmooth Future Server running on ${PORT}`));