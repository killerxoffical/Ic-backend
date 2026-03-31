// --- START: FULLY UPDATED server.js (v19 - Real Broker Tick Behavior) ---

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// 🔥 আপনার ফায়ারবেস কনফিগারেশন
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
const TICK_MS = 500; 
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
    // রিয়েল ব্রোকার বিহেভিয়ারের জন্য স্টেট ভেরিয়েবল
    targetPrice: currentPrice,
    trendDirection: 0,
    tickCount: 0
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
    // নতুন ক্যান্ডেল শুরু হলে টার্গেট রিসেট
    marketData.targetPrice = lastCandle.close;
    marketData.trendDirection = 0;
    return newCandle;
  }
  return lastCandle;
}

// 🔥 CRITICAL FIX: Real Broker Tick Behavior (Pocket Option / Quotex Style)
function updateCandlePrice(marketData, candle) {
    marketData.tickCount++;
    const openPrice = candle.open;
    const baseVolatility = openPrice * 0.00004; // সাধারণ মুভমেন্ট সাইজ

    // ১. Random Stall (৭০% সময় প্রাইস খুব সামান্য কাঁপবে, বড় মুভমেন্ট হবে না)
    // এটি "পানির মতো" টানা মুভমেন্ট বন্ধ করবে এবং রিয়েলিস্টিক ফিল দেবে।
    if (Math.random() < 0.70) {
        // Micro-jitter (খুবই সামান্য কাঁপাকাপি)
        const jitter = (Math.random() - 0.5) * (baseVolatility * 0.3);
        
        // যদি টার্গেট প্রাইস থাকে, তবে সেদিকে খুব ধীরে এগোবে (LERP)
        marketData.currentPrice += (marketData.targetPrice - marketData.currentPrice) * 0.1;
        marketData.currentPrice += jitter;
    } 
    // ২. Impulse Move (হঠাৎ করে একটা বড় লাফ দেওয়া)
    else {
        // প্রতি ১০-১৫ টিকে একবার ট্রেন্ডের দিক (Trend Direction) চেঞ্জ হতে পারে
        if (marketData.tickCount % 12 === 0 || Math.random() < 0.1) {
            marketData.trendDirection = Math.random() > 0.5 ? 1 : -1;
        }

        // লাফের সাইজ নির্ধারণ (মাঝে মাঝে অনেক বড় লাফ দেবে)
        const isBigJump = Math.random() < 0.15;
        const jumpSize = isBigJump ? baseVolatility * (4 + Math.random() * 4) : baseVolatility * (1 + Math.random() * 2);
        
        // টার্গেট প্রাইস সেট করা (এই প্রাইসের দিকে ক্যান্ডেল লাফ দেবে)
        const move = marketData.trendDirection * jumpSize;
        marketData.targetPrice = marketData.currentPrice + move;

        // ৩. Micro-Pullback (লাফ দেওয়ার পর উল্টো দিকে একটু ব্যাক করা)
        // রিয়েল মার্কেটে প্রাইস একটা লেভেলে হিট করে সাথে সাথে একটু রিজেকশন খায়
        const pullBack = -move * (0.2 + Math.random() * 0.3); // ২০-৫০% রিজেকশন
        marketData.targetPrice += pullBack;
        
        // প্রাইসকে টার্গেটের কাছাকাছি নিয়ে যাওয়া (ধাক্কা দেওয়া)
        marketData.currentPrice += move * 0.8; 
    }

    // ৪. Mean Reversion / Boundary Check (ক্যান্ডেল যেন অস্বাভাবিক বড় না হয়ে যায়)
    const maxCandleSize = openPrice * 0.0008; // ক্যান্ডেলের সর্বোচ্চ সাইজ
    const currentDistance = marketData.currentPrice - openPrice;

    if (Math.abs(currentDistance) > maxCandleSize) {
        // লিমিটে পৌঁছে গেলে জোর করে রিভার্স করা (শ্যাডো/উইক তৈরি হবে)
        marketData.trendDirection = currentDistance > 0 ? -1 : 1;
        marketData.targetPrice = openPrice + (currentDistance > 0 ? maxCandleSize * 0.8 : -maxCandleSize * 0.8);
    }

    // ফাইনাল প্রাইস আপডেট
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
            
            for (const marketId in markets) {
                const marketData = markets[marketId];
                let candle = ensureCurrentPeriodCandle(marketData, currentPeriod);
                if (!candle) continue;

                // রিয়েলিস্টিক ব্রোকার বিহেভিয়ার কল করা হচ্ছে
                updateCandlePrice(marketData, candle);
                broadcastCandle(marketId, candle);
            }

            // Firebase Batch Backup (১ মিনিটে ১ বার)
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

app.get('/ping', (_req, res) => res.send('UltraSmooth v19 - Real Broker Tick Behavior Active'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server v19 Real Tick Behavior active on ${PORT}`));

// --- END OF FILE ---