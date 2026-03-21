const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

const MAX_CANDLES = 5000;
const TIMEFRAME = 60000;
const TICK_MS = 200;
const MIN_PRICE = 0.00001;
const HISTORY_SEED_COUNT = 300;

const markets = {};
const adminOverrides = {};
const adminPatterns = {};

function roundPrice(v) {
  return parseFloat(Math.max(MIN_PRICE, v).toFixed(5));
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function marketPathFromId(marketId) {
  return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase();
}

function cloneCandle(c) {
  return {
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close
  };
}

function generateHistoricalCandle(timestamp, open) {
  const safeOpen = Math.max(MIN_PRICE, open);
  const isGreen = Math.random() > 0.5;
  const body = randomBetween(0.00006, 0.00028) * safeOpen;
  const close = isGreen ? safeOpen + body : safeOpen - body;
  const upperWick = randomBetween(0.00003, 0.00018) * safeOpen;
  const lowerWick = randomBetween(0.00003, 0.00018) * safeOpen;

  return {
    timestamp,
    open: roundPrice(safeOpen),
    high: roundPrice(Math.max(safeOpen, close) + upperWick),
    low: roundPrice(Math.min(safeOpen, close) - lowerWick),
    close: roundPrice(close)
  };
}

function getAverageRange(history, count = 20) {
  const recent = history.slice(-count);
  if (!recent.length) return 0.0003;
  const total = recent.reduce((sum, c) => sum + Math.abs(c.high - c.low), 0);
  return total / recent.length;
}

// --- NEW: Market Personality Engine ---
function createMarketPersonality(marketId) {
    const seed = marketId.split("").reduce((a, b) => { a = ((a << 5) - a) + b.charCodeAt(0); return a & a }, 0);
    const seededRandom = (s) => {
        let x = Math.sin(s) * 10000;
        return x - Math.floor(x);
    };

    return {
        baseVolatility: 0.00010 + seededRandom(seed + 1) * 0.00010, // 0.00010 to 0.00020
        meanReversion: 0.010 + seededRandom(seed + 2) * 0.025,   // 0.010 to 0.035
        randomness: 2.0 + seededRandom(seed + 3) * 1.5,           // 2.0 to 3.5
        gravityPower: 3.5 + seededRandom(seed + 4) * 1.5          // 3.5 to 5.0
    };
}


function initializeNewMarket(marketId, fbMarket = {}) {
  let startPrice = 1.15 + (Math.random() - 0.5) * 0.1;

  const ids = Object.keys(markets);
  if (ids.length) {
    const randomId = ids[Math.floor(Math.random() * ids.length)];
    const last = markets[randomId]?.history?.[markets[randomId].history.length - 1];
    if (last?.close) startPrice = last.close;
  }

  const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
  const candles = [];
  let currentPrice = Math.max(MIN_PRICE, startPrice);

  for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
    const c = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
    candles.push(c);
    currentPrice = c.close;
  }

  const last = candles[candles.length - 1];

  markets[marketId] = {
    marketId,
    marketPath: marketPathFromId(marketId),
    personality: createMarketPersonality(marketId), // Assign personality
    history: candles,
    currentPrice: last.close,
    tickCount: 0,
    activeCommand: null,
    currentCommandSignature: null,
    lastMirroredTs: 0,
    lastPeriod: last.timestamp
  };

  mirrorCandleToFirebase(markets[marketId], last, true).catch(() => {});
}

function createFlatCurrentCandle(timestamp, price) {
  const safe = roundPrice(price);
  return { timestamp, open: safe, high: safe, low: safe, close: safe };
}

function ensureCurrentPeriodCandle(marketData, currentPeriod) {
  let lastCandle = marketData.history[marketData.history.length - 1];

  if (!lastCandle) {
    const fallback = createFlatCurrentCandle(currentPeriod, marketData.currentPrice || 1.15);
    marketData.history.push(fallback);
    marketData.currentPrice = fallback.close;
    return fallback;
  }

  const diff = currentPeriod - lastCandle.timestamp;
  if (diff < TIMEFRAME) return lastCandle;

  const missingCount = Math.floor(diff / TIMEFRAME);
  let ts = lastCandle.timestamp;

  for (let i = 0; i < missingCount; i++) {
    ts += TIMEFRAME;
    let newCandle;
    if (ts < currentPeriod) {
      newCandle = generateHistoricalCandle(ts, lastCandle.close);
    } else {
      newCandle = createFlatCurrentCandle(ts, lastCandle.close);
    }
    marketData.history.push(newCandle);
    if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
    lastCandle = newCandle;
  }

  marketData.currentPrice = lastCandle.close;
  marketData.tickCount = 0;
  marketData.lastPeriod = lastCandle.timestamp;
  marketData.activeCommand = null;

  return lastCandle;
}

function makeCommandShape(open, direction, label, history) {
    const avgRange = getAverageRange(history, 20);
    const maxRange = Math.max(avgRange * 1.20, 0.00025);
    const style = Math.floor(Math.random() * 6);

    let totalRange, bodyRatio, upperRatio, lowerRatio;

    if (style === 0) {
        totalRange = maxRange * randomBetween(0.45, 0.70); bodyRatio = randomBetween(0.10, 0.18);
        upperRatio = randomBetween(0.30, 0.45); lowerRatio = 1 - bodyRatio - upperRatio;
    } else if (style === 1) {
        totalRange = maxRange * randomBetween(0.55, 0.85); bodyRatio = randomBetween(0.35, 0.55);
        upperRatio = randomBetween(0.12, 0.22); lowerRatio = 1 - bodyRatio - upperRatio;
    } else if (style === 2) {
        totalRange = maxRange * randomBetween(0.60, 0.95); bodyRatio = randomBetween(0.20, 0.35);
        upperRatio = randomBetween(0.08, 0.16); lowerRatio = 1 - bodyRatio - upperRatio;
    } else if (style === 3) {
        totalRange = maxRange * randomBetween(0.60, 0.95); bodyRatio = randomBetween(0.20, 0.35);
        upperRatio = randomBetween(0.35, 0.50); lowerRatio = 1 - bodyRatio - upperRatio;
    } else {
        totalRange = maxRange * randomBetween(0.75, 1.05); bodyRatio = randomBetween(0.45, 0.70);
        upperRatio = randomBetween(0.08, 0.16); lowerRatio = 1 - bodyRatio - upperRatio;
    }

    if (lowerRatio < 0.08) lowerRatio = 0.08;
    if (upperRatio < 0.08) upperRatio = 0.08;

    const bodyMove = totalRange * bodyRatio;
    const upperWick = totalRange * upperRatio;
    const lowerWick = totalRange * lowerRatio;
    const extraWickRoom = totalRange * 0.25;

    let desiredClose, desiredHigh, desiredLow;
    if (direction === 'GREEN') {
        desiredClose = open + bodyMove;
        desiredHigh = Math.max(open, desiredClose) + upperWick + extraWickRoom;
        desiredLow = Math.min(open, desiredClose) - lowerWick;
    } else {
        desiredClose = open - bodyMove;
        desiredHigh = Math.max(open, desiredClose) + upperWick;
        desiredLow = Math.min(open, desiredClose) - lowerWick - extraWickRoom;
    }

    return {
        label, direction,
        desiredClose: roundPrice(desiredClose),
        desiredHigh: roundPrice(desiredHigh),
        desiredLow: roundPrice(desiredLow),
        expiresAt: Date.now() + 65000
    };
}

function parseCustomOverride(type, open, history) {
  const parts = String(type).split('_');
  const color = parts[2] === 'GREEN' ? 'GREEN' : 'RED';
  const upper = Math.max(0, Math.min(100, parseInt(parts[3], 10) || 20));
  const body = Math.max(5, Math.min(100, parseInt(parts[4], 10) || 60));
  const lower = Math.max(0, Math.min(100, parseInt(parts[5], 10) || 20));

  const avgRange = getAverageRange(history, 20);
  const maxRange = Math.max(avgRange * 1.20, 0.00025);
  const totalScale = maxRange;

  const totalParts = upper + body + lower || 100;
  const upperWick = totalScale * (upper / totalParts);
  const bodyMove = totalScale * (body / totalParts);
  const lowerWick = totalScale * (lower / totalParts);
  const extraWickRoom = totalScale * 0.25;

  const desiredClose = color === 'GREEN' ? open + bodyMove : open - bodyMove;
  const desiredHigh = Math.max(open, desiredClose) + upperWick + extraWickRoom;
  const desiredLow = Math.min(open, desiredClose) - lowerWick - extraWickRoom;

  return {
    label: type,
    direction: color,
    desiredClose: roundPrice(desiredClose),
    desiredHigh: roundPrice(desiredHigh),
    desiredLow: roundPrice(desiredLow),
    expiresAt: Date.now() + 65000
  };
}

function getCommandForCurrentCandle(marketId, marketData, lastCandle, currentPeriod) {
  const override = adminOverrides[marketId];
  if (override && override.timestamp > Date.now() - 65000) {
    const signature = `override:${override.timestamp}:${override.type}`;
    if (marketData.currentCommandSignature !== signature) {
      marketData.currentCommandSignature = signature;
      if (String(override.type).startsWith('PATTERN_CUSTOM_')) {
        return parseCustomOverride(override.type, lastCandle.open, marketData.history);
      }
      const direction = (override.type === 'UP' || String(override.type).includes('BULLISH') || String(override.type).includes('WHITE')) ? 'GREEN' : 'RED';
      return makeCommandShape(lastCandle.open, direction, override.type, marketData.history);
    }
    return marketData.activeCommand;
  }

  const patternConfig = adminPatterns[marketId];
  if (patternConfig && patternConfig.isActive) {
    const index = Math.floor((currentPeriod - patternConfig.startTime) / (patternConfig.timeframe * 1000));
    if (index >= 0 && index < patternConfig.pattern.length) {
      const step = patternConfig.pattern[index];
      const signature = `pattern:${patternConfig.startTime}:${index}:${step}`;
      if (marketData.currentCommandSignature !== signature) {
        marketData.currentCommandSignature = signature;
        return makeCommandShape(lastCandle.open, step === 'GREEN' ? 'GREEN' : 'RED', step, marketData.history);
      }
      return marketData.activeCommand;
    }
  }

  marketData.currentCommandSignature = null;
  return null;
}

// --- NEW (REPLACED) `updateControlledCandle` function ---
function updateControlledCandle(marketData, candle, now) {
    const cmd = marketData.activeCommand;
    const p = marketData.personality;
    const progress = Math.max(0, Math.min(1, (now - candle.timestamp) / TIMEFRAME));

    const baseVol = Math.max(candle.open * p.baseVolatility, MIN_PRICE);
    const randomMove = (Math.random() - 0.5) * baseVol * p.randomness;
    const meanReversion = -(marketData.currentPrice - candle.open) * p.meanReversion;

    const pullStrength = Math.pow(progress, p.gravityPower) * 0.35;
    const pullForce = (cmd.desiredClose - marketData.currentPrice) * pullStrength;

    let priceChange = randomMove + meanReversion + pullForce;
    marketData.currentPrice += priceChange;

    if (progress > 0.98) {
        marketData.currentPrice += (cmd.desiredClose - marketData.currentPrice) * 0.6;
    }
    
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = roundPrice(Math.min(cmd.desiredHigh, Math.max(candle.high, candle.close)));
    candle.low = roundPrice(Math.max(cmd.desiredLow, Math.min(candle.low, candle.close)));
    marketData.currentPrice = candle.close;
}

// --- NEW (REPLACED) `updateNaturalCandle` function ---
function updateNaturalCandle(marketData, candle) {
    const p = marketData.personality;
    const baseVol = Math.max(candle.open * p.baseVolatility, MIN_PRICE);
    const randomMove = (Math.random() - 0.5) * baseVol * p.randomness;
    const meanReversionForce = -(marketData.currentPrice - candle.open) * p.meanReversion; 
    
    const priceChange = randomMove + meanReversionForce;
    marketData.currentPrice = Math.max(MIN_PRICE, marketData.currentPrice + priceChange);
    
    candle.close = roundPrice(marketData.currentPrice);
    candle.high = roundPrice(Math.max(candle.high, candle.close));
    candle.low = roundPrice(Math.min(candle.low, candle.close));
    marketData.currentPrice = candle.close;
}


async function mirrorCandleToFirebase(marketData, candle, force = false) {
  if (!marketData || !candle) return;
  if (!force && marketData.lastMirroredTs === candle.timestamp && Date.now() - candle.timestamp > TIMEFRAME) return;

  marketData.lastMirroredTs = candle.timestamp;
  const candlePayload = cloneCandle(candle);

  const updates = {};
  updates[`markets/${marketData.marketPath}/candles/60s/${candle.timestamp}`] = candlePayload;
  updates[`markets/${marketData.marketPath}/live`] = {
    price: candle.close,
    lastPrice: candle.open,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    timestamp: candle.timestamp,
    marketId: marketData.marketId,
    updatedAt: Date.now()
  };

  try {
    await db.ref().update(updates);
  } catch (err) {
    console.error('Firebase mirror failed:', err.message);
  }
}

function shouldSendToClient(client, marketId) {
  if (!client.subscribedMarket) return true;
  return client.subscribedMarket === marketId;
}

function broadcastCandle(marketId, candle) {
  const payload = JSON.stringify({
    market: marketId,
    candle,
    serverTime: Date.now(),
    timeframe: TIMEFRAME
  });

  wss.clients.forEach((client) => {
    if (client.readyState !== WebSocket.OPEN) return;
    if (!shouldSendToClient(client, marketId)) return;
    client.send(payload);
  });
}

const adminMarketsRef = db.ref('admin/markets');
adminMarketsRef.on('value', (snapshot) => {
  const fbMarkets = snapshot.val() || {};

  Object.keys(fbMarkets).forEach((marketId) => {
    const type = fbMarkets[marketId]?.type;
    if ((type === 'otc' || type === 'broker_real') && !markets[marketId]) {
      initializeNewMarket(marketId, fbMarkets[marketId]);
    }
  });

  Object.keys(markets).forEach((marketId) => {
    const fbMarket = fbMarkets[marketId];
    if (!fbMarket || (fbMarket.type !== 'otc' && fbMarket.type !== 'broker_real')) {
      delete markets[marketId];
      delete adminOverrides[marketId];
      delete adminPatterns[marketId];
    }
  });
});

db.ref('admin/market_overrides').on('value', (snap) => {
  const next = snap.val() || {};
  Object.keys(adminOverrides).forEach((key) => {
    if (!(key in next)) delete adminOverrides[key];
  });
  Object.assign(adminOverrides, next);
});

db.ref('admin/markets').on('value', (snap) => {
  const data = snap.val() || {};
  Object.keys(adminPatterns).forEach((key) => {
    if (!data[key]?.pattern_config) delete adminPatterns[key];
  });
  Object.keys(data).forEach((id) => {
    if (data[id]?.pattern_config) adminPatterns[id] = data[id].pattern_config;
  });
});

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.subscribedMarket = null;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg?.type === 'subscribe' && typeof msg.market === 'string') {
        ws.subscribedMarket = msg.market;
        const marketData = markets[msg.market];
        const latest = marketData?.history?.[marketData.history.length - 1];

        if (latest && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'subscribed',
            market: msg.market,
            candle: latest,
            serverTime: Date.now(),
            timeframe: TIMEFRAME
          }));
        }
      }
    } catch (_) {}
  });
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

// --- MAIN SERVER LOOP ---
setInterval(async () => {
  const now = Date.now();
  const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;

  for (const marketId of Object.keys(markets)) {
    const marketData = markets[marketId];
    if (!marketData?.history?.length) continue;

    let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
    if (!candle) continue;

    const cmd = getCommandForCurrentCandle(marketId, marketData, candle, currentPeriod);
    marketData.activeCommand = cmd;

    if (cmd) {
      updateControlledCandle(marketData, candle, now);
    } else {
      updateNaturalCandle(marketData, candle);
    }

    marketData.lastPeriod = candle.timestamp;
    const cloned = cloneCandle(candle);

    broadcastCandle(marketId, cloned);
    await mirrorCandleToFirebase(marketData, cloned);
  }
}, TICK_MS);

app.get('/api/history/:market', (req, res) => {
  const marketId = req.params.market;
  const marketData = markets[marketId];

  if (!marketData?.history?.length) {
    res.status(404).json([]);
    return;
  }

  res.json(marketData.history.map(cloneCandle));
});

app.get('/ping', (_req, res) => {
  res.send('UltraSmooth V13 - Dynamic Personality Engine');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ultra Smooth Server v13 on ${PORT}`);
});

server.on('close', () => clearInterval(heartbeat));