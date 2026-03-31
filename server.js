// --- START: FULLY UPDATED server.js (v18 - Realistic Quotex-style Movement) ---

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
app.use(express.json());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const MAX_CANDLES_IN_RAM = 1000;
const TIMEFRAME = 60000;
const TICK_MS = 300; 
const HISTORY_SEED_COUNT = 300;

const markets = {}; 

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
    currentPrice: currentPrice,
    momentum: 0 // নতুন: রিয়েলিস্টিক মুভমেন্টের জন্য মোমেন্টাম
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
    if (marketData.history.length > MAX_CANDLES_IN_RAM) {
      marketData.history.shift();
    }
    // নতুন ক্যান্ডেল শুরু হলে মোমেন্টাম জিরো করে দেওয়া
    marketData.momentum = 0; 
    return newCandle;
  }
  return lastCandle;
}

// 🔥 CRITICAL FIX: রিয়েলিস্টিক (Quotex/Binomo style) ক্যান্ডেল মুভমেন্ট
function updateCandlePrice(marketData, candle) {
  // ১. Random Stall (মাঝে মাঝে প্রাইস এক জায়গায় দাঁড়িয়ে থাকবে)
  // ২৫% সম্ভাবনা আছে যে এই টিকে প্রাইস নড়বেই না (রিয়েল মার্কেটের মতো)
  if (Math.random() < 0.25) return;

  const baseVolatility = 0.00008; // সাধারণ নড়াচড়ার সাইজ
  
  // ২. Micro-Jumps (হঠাৎ বড় লাফ দেওয়া)
  // ১০% সম্ভাবনা আছে প্রাইস হঠাৎ করে বড় লাফ দেবে
  const isJump = Math.random() < 0.10;
  const volatility = isJump ? baseVolatility * (3 + Math.random() * 3) : baseVolatility;

  // ৩. Momentum & Trend (একদিকে যাওয়ার প্রবণতা)
  // রেন্ডমলি মোমেন্টাম চেঞ্জ হবে (Trend direction)
  if (Math.random() < 0.15) {
      marketData.momentum = (Math.random() - 0.5) * 2; // -1 থেকে +1 এর মধ্যে
  }
  
  // প্রাইস মুভমেন্ট ক্যালকুলেশন (রেন্ডম নয়েজ + মোমেন্টাম)
  let rawMove = (Math.random() - 0.5 + (marketData.momentum * 0.3)) * (candle.open * volatility);

  // ৪. Mean Reversion (রিজেকশন খাওয়া)
  // প্রাইস ক্যান্ডেলের ওপেন থেকে অনেক দূরে চলে গেলে শ্যাডো (Wick) তৈরি করার জন্য রিজেকশন নেবে
  const distance = marketData.currentPrice - candle.open;
  const maxDistance = candle.open * 0.0005; // ক্যান্ডেলের সর্বোচ্চ সাইজ লিমিট
  
  if (Math.abs(distance) > maxDistance) {
      // লিমিট পার হলে জোর করে বিপরীত দিকে ঠেলে দেওয়া (Rejection)
      const pullBackForce = distance > 0 ? -0.5 : 0.5;
      rawMove += pullBackForce * (candle.open * baseVolatility * 2);
  }

  // ৫. Tick Noise (কাঁপাকাঁপি)
  const jitter = (Math.random() - 0.5) * (candle.open * 0.00002);
  
  // ফাইনাল প্রাইস আপডেট
  marketData.currentPrice += (rawMove + jitter);

  // ক্যান্ডেলের হাই, লো এবং ক্লোজ আপডেট করা
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

// 🔥 MAIN LOOP (Async & Batched)
(async () => {
    let lastSyncMinute = 0;

    setInterval(async () => {
        try {
            const now = Date.now();
            const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
            const currentMinute = Math.floor(now / 60000);
            
            // 1. Chart Update & Broadcast
            for (const marketId in markets) {
                const marketData = markets[marketId];
                let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
                if (!candle) continue;

                // রিয়েলিস্টিক প্রাইস আপডেট কল করা হচ্ছে
                updateCandlePrice(marketData, candle);
                broadcastCandle(marketId, candle);
            }

            // 2. Firebase Backup (Batch - Every 1 Minute)
            if (currentMinute > lastSyncMinute) {
                lastSyncMinute = currentMinute;
                const batchUpdates = {};
                let marketsToSync = 0;
                
                for (const marketId in markets) {
                    const marketData = markets[marketId];
                    const lastCandle = marketData.history[marketData.history.length-1];
                    if (lastCandle) {
                        batchUpdates[`markets/${marketData.marketPath}/live`] = { 
                            price: lastCandle.close, 
                            timestamp: lastCandle.timestamp 
                        };
                        marketsToSync++;
                    }
                }
                
                if (marketsToSync > 0) {
                    await db.ref().update(batchUpdates);
                    // console.log(`[Firebase Backup] Batched sync for ${marketsToSync} markets successful.`);
                }
            }
        } catch (error) {
            console.error("Main loop error:", error);
        }
    }, TICK_MS);
})();

// API routes
app.get('/api/history/:market', (req, res) => {
  const marketData = markets[req.params.market];
  if (!marketData) return res.status(404).json([]);
  res.json(marketData.history.map(cloneCandle));
});

// Manual Backup API
app.post('/api/backup', async (req, res) => {
    try {
        const batchUpdates = {}; 
        let marketsToSync = 0;
        
        for (const marketId in markets) {
            const marketData = markets[marketId];
            const lastCandle = marketData.history[marketData.history.length-1];
            if(lastCandle) {
                batchUpdates[`markets/${marketData.marketPath}/live`] = {
                    price: lastCandle.close,
                    timestamp: lastCandle.timestamp
                };
                marketsToSync++;
            }
        }
        
        if (marketsToSync > 0) {
            await db.ref().update(batchUpdates);
            res.json({ success: true, message: `Successfully backed up ${marketsToSync} markets.` });
        } else {
            res.json({ success: false, message: "No active markets found to backup." });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: "Backup failed.", error: err.message });
    }
});

app.get('/ping', (_req, res) => res.send('UltraSmooth v18 - Realistic Movement Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server v18 Realistic Movement active on ${PORT}`));

// --- END OF FILE ---