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
  const body = (Math.random() * 0.0004) * safeOpen;
  const close = isGreen ? safeOpen + body : safeOpen - body;
  const upperWick = (Math.random() * 0.0002) * safeOpen;
  const lowerWick = (Math.random() * 0.0002) * safeOpen;

  return {
    timestamp,
    open: roundPrice(safeOpen),
    high: roundPrice(Math.max(safeOpen, close) + upperWick),
    low: roundPrice(Math.min(safeOpen, close) - lowerWick),
    close: roundPrice(close)
  };
}

function initializeNewMarket(marketId, fbMarket = {}) {
  let startPrice = 1.15 + (Math.random() - 0.5) * 0.1;
  const existingIds = Object.keys(markets);
  if (existingIds.length) {
    const randomId = existingIds[Math.floor(Math.random() * existingIds.length)];
    const last = markets[randomId]?.history?.[markets[randomId].history.length - 1];
    if (last?.close) startPrice = last.close;
  }

  const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
  const candles = [];
  let currentPrice = Math.max(MIN_PRICE, startPrice);
  for (let i = HISTORY_SEED_COUNT; i > 0; i--) {
    const candle = generateHistoricalCandle(nowPeriod - (i * TIMEFRAME), currentPrice);
    candles.push(candle);
    currentPrice = candle.close;
  }

  const last = candles[candles.length - 1];
  markets[marketId] = {
    marketId,
    marketPath: marketPathFromId(marketId),
    history: candles,
    currentPrice: last.close,
    driftTarget: last.close,
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
    marketData.driftTarget = fallback.close;
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
  marketData.driftTarget = lastCandle.close;
  marketData.tickCount = 0;
  marketData.lastPeriod = lastCandle.timestamp;
  marketData.activeCommand = null;
  return lastCandle;
}

function parseCustomOverride(type, open) {
  const parts = String(type).split('_');
  const color = parts[2] === 'GREEN' ? 'GREEN' : 'RED';
  const upper = Math.max(0, Math.min(100, parseInt(parts[3], 10) || 20));
  const body = Math.max(5, Math.min(100, parseInt(parts[4], 10) || 60));
  const lower = Math.max(0, Math.min(100, parseInt(parts[5], 10) || 20));

  const totalScale = Math.max(open * 0.001, 0.0004);
  const bodyMove = totalScale * (body / 100);
  const upperWick = totalScale * 0.7 * (upper / 100);
  const lowerWick = totalScale * 0.7 * (lower / 100);

  const desiredClose = color === 'GREEN' ? open + bodyMove : open - bodyMove;
  const desiredHigh = color === 'GREEN'
    ? Math.max(open, desiredClose) + upperWick
    : Math.max(open, desiredClose) + upperWick * 0.6;
  const desiredLow = color === 'GREEN'
    ? Math.min(open, desiredClose) - lowerWick * 0.6
    : Math.min(open, desiredClose) - lowerWick;

  return {
    label: type,
    direction: color,
    desiredClose: roundPrice(desiredClose),
    desiredHigh: roundPrice(desiredHigh),
    desiredLow: roundPrice(desiredLow),
    expiresAt: Date.now() + 65000
  };
}

function buildDirectedCommand(label, direction, open) {
  const base = Math.max(open * 0.0009, 0.00035);
  const body = base * (0.55 + Math.random() * 0.35);
  const upperWick = base * (0.10 + Math.random() * 0.35);
  const lowerWick = base * (0.10 + Math.random() * 0.35);

  const desiredClose = direction === 'GREEN' ? open + body : open - body;
  const desiredHigh = direction === 'GREEN'
    ? Math.max(open, desiredClose) + upperWick
    : Math.max(open, desiredClose) + upperWick * 0.75;
  const desiredLow = direction === 'GREEN'
    ? Math.min(open, desiredClose) - lowerWick * 0.75
    : Math.min(open, desiredClose) - lowerWick;

  return {
    label,
    direction,
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
        return parseCustomOverride(override.type, lastCandle.open);
      }
      if (override.type === 'UP' || override.type === 'GREEN') {
        return buildDirectedCommand(override.type, 'GREEN', lastCandle.open);
      }
      if (override.type === 'DOWN' || override.type === 'RED') {
        return buildDirectedCommand(override.type, 'RED', lastCandle.open);
      }
      if (String(override.type).includes('BULLISH') || String(override.type).includes('WHITE')) {
        return buildDirectedCommand(override.type, 'GREEN', lastCandle.open);
      }
      if (String(override.type).includes('BEARISH') || String(override.type).includes('BLACK')) {
        return buildDirectedCommand(override.type, 'RED', lastCandle.open);
      }
      return buildDirectedCommand(override.type, Math.random() > 0.5 ? 'GREEN' : 'RED', lastCandle.open);
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
        return buildDirectedCommand(step, step === 'GREEN' ? 'GREEN' : 'RED', lastCandle.open);
      }
      return marketData.activeCommand;
    }
  }

  marketData.currentCommandSignature = null;
  return null;
}

function getNaturalDriftTarget(lastCandle, currentPrice) {
  const baseVol = Math.max(lastCandle.open * 0.00015, 0.00001);
  const randomMove = (Math.random() - 0.5) * baseVol * 2.2;
  const distanceToOpen = currentPrice - lastCandle.open;
  const meanReversion = -distanceToOpen * 0.10;
  return currentPrice + randomMove + meanReversion;
}

function updateControlledCandle(marketData, candle, now) {
  const cmd = marketData.activeCommand;
  const progress = Math.max(0, Math.min(1, (now - candle.timestamp) / TIMEFRAME));
  const range = Math.max(Math.abs(cmd.desiredClose - candle.open), 0.0001);
  const noise = range * 0.14;

  let anchor;
  if (progress < 0.18) {
    const fakeDir = cmd.direction === 'GREEN' ? -1 : 1;
    anchor = candle.open + fakeDir * range * (0.08 + Math.random() * 0.07);
  } else if (progress < 0.55) {
    const toward = cmd.direction === 'GREEN'
      ? candle.open + (cmd.desiredHigh - candle.open) * (0.35 + progress)
      : candle.open - (candle.open - cmd.desiredLow) * (0.35 + progress);
    anchor = toward + (Math.random() - 0.5) * noise;
  } else if (progress < 0.82) {
    const mid = (cmd.desiredClose + (cmd.direction === 'GREEN' ? cmd.desiredHigh : cmd.desiredLow)) / 2;
    anchor = mid + (Math.random() - 0.5) * noise * 0.8;
  } else {
    const settle = cmd.desiredClose + (Math.random() - 0.5) * noise * 0.35;
    const blend = 0.20 + (progress - 0.82) / 0.18 * 0.55;
    anchor = marketData.currentPrice + (settle - marketData.currentPrice) * blend;
  }

  marketData.currentPrice = roundPrice(anchor);
  candle.close = marketData.currentPrice;
  candle.high = roundPrice(Math.max(candle.high, candle.close));
  candle.low = roundPrice(Math.min(candle.low, candle.close));

  if (progress >= 0.96) {
    candle.close = roundPrice(cmd.desiredClose + (Math.random() - 0.5) * range * 0.03);
    candle.high = roundPrice(Math.max(candle.high, cmd.desiredHigh));
    candle.low = roundPrice(Math.min(candle.low, cmd.desiredLow));
    marketData.currentPrice = candle.close;
  }
}

function updateNaturalCandle(marketData, candle) {
  marketData.tickCount += 1;
  if (marketData.tickCount >= 10 || !Number.isFinite(marketData.driftTarget)) {
    marketData.tickCount = 0;
    marketData.driftTarget = getNaturalDriftTarget(candle, marketData.currentPrice);
  }

  const distance = marketData.driftTarget - marketData.currentPrice;
  let step = distance * 0.15;
  if (Math.abs(step) < 0.000001) step = distance === 0 ? 0 : (distance > 0 ? 0.000001 : -0.000001);
  marketData.currentPrice = Math.max(MIN_PRICE, marketData.currentPrice + step);
  const jitter = (Math.random() - 0.5) * 0.000008 * Math.max(candle.open, MIN_PRICE);
  candle.close = roundPrice(marketData.currentPrice + jitter);
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
    if (fbMarkets[marketId]?.type === 'otc' && !markets[marketId]) {
      initializeNewMarket(marketId, fbMarkets[marketId]);
    }
  });

  Object.keys(markets).forEach((marketId) => {
    if (!fbMarkets[marketId] || fbMarkets[marketId].type !== 'otc') {
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

  ws.on('pong', () => { ws.isAlive = true; });

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
  res.send('UltraSmooth V9 - Admin Synced Natural Engine');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Ultra Smooth Server v9 on ${PORT}`);
});

server.on('close', () => clearInterval(heartbeat));