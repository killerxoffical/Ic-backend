const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

// --- CONFIGURATION ---
const mainConfig = { databaseURL: "https://ictex-trade-default-rtdb.firebaseio.com" };
const adminConfig = { databaseURL: "https://earning-xone-v1-default-rtdb.firebaseio.com" };

const mainApp = firebase.initializeApp(mainConfig, "main");
const adminApp = firebase.initializeApp(adminConfig, "admin");
const mainDb = mainApp.database();
const adminDb = adminApp.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const TIMEFRAME = 60000;
const CANDLE_PATH_STEPS = 1000;
const markets = {};

// ১. মার্কেট ইনিশিয়ালাইজেশন
mainDb.ref('admin/markets').on('value', snapshot => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(id => {
        if (data[id].status === 'active' && !markets[id]) {
            markets[id] = { history: [{ timestamp: 0, close: 1.15500 }], lastSync: 0 };
        }
    });
});

// ২. ক্যান্ডেল জেনারেশন ইঞ্জিন (Path with 1000 points)
function generateCandle(timestamp, open, type) {
    const volatility = open * 0.0004;
    const bodySize = volatility * (0.8 + Math.random());
    const close = (type === "UP") ? open + bodySize : open - bodySize;
    const high = Math.max(open, close) + (volatility * 0.2);
    const low = Math.min(open, close) - (volatility * 0.2);

    const path = [];
    for (let i = 0; i < CANDLE_PATH_STEPS; i++) {
        const progress = i / (CANDLE_PATH_STEPS - 1);
        let p = open + (close - open) * progress;
        p += (Math.random() - 0.5) * (volatility * 0.1);
        path.push(parseFloat(p.toFixed(5)));
    }
    return { timestamp, open, high, low, close, path, isForced: true };
}

// ৩. মেইন লুপ
setInterval(async () => {
    const now = Date.now();
    const currentPeriod = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const timeIntoCandle = now - currentPeriod;

    for (const marketId in markets) {
        const m = markets[marketId];
        let lastCandle = m.history[m.history.length - 1];

        // ক্যান্ডেল রোলওভার (১ মিনিট পর পর)
        if (currentPeriod > lastCandle.timestamp) {
            const planSnap = await adminDb.ref(`candle_plans/${marketId}`).once('value');
            const plan = planSnap.val();

            let types = ["UP", "DOWN", "UP", "DOWN", "UP", "DOWN"];
            let currentIndex = 0;

            if (plan) {
                types = plan.pattern;
                currentIndex = plan.currentIndex;
                // যদি ৬টা শেষ হয়ে যায়, নতুন অটো প্ল্যান বানাও
                if (currentIndex >= 6) {
                    currentIndex = 0;
                    types = types.sort(() => Math.random() - 0.5); // র‍্যান্ডমাইজ
                    await adminDb.ref(`candle_plans/${marketId}`).update({ pattern: types, currentIndex: 0 });
                }
            }

            const nextType = types[currentIndex];
            const newCandle = generateCandle(currentPeriod, lastCandle.close, nextType);
            
            m.history.push(newCandle);
            if (m.history.length > 10) m.history.shift();
            
            // অ্যাডমিন ডিবির ইনডেক্স বাড়ানো
            adminDb.ref(`candle_plans/${marketId}/currentIndex`).set(currentIndex + 1);
            
            // মেইন ডিবির লাইভ প্রাইস আপডেট (Monitor এর জন্য)
            const path = String(marketId).replace(/[\.\/ ]/g, '-').toLowerCase();
            mainDb.ref(`markets/${path}/live`).set({ price: newCandle.open, timestamp: now });
        }

        // লাইভ টিক পাঠানো (Path index অনুযায়ী)
        const pathIndex = Math.min(CANDLE_PATH_STEPS - 1, Math.floor((timeIntoCandle / TIMEFRAME) * CANDLE_PATH_STEPS));
        const livePrice = m.history[m.history.length - 1].path[pathIndex];
        
        const payload = JSON.stringify({
            type: 'subscribed', market: marketId,
            candle: { ...m.history[m.history.length - 1], close: livePrice }
        });

        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === marketId) client.send(payload);
        });
    }
}, 300);

wss.on('connection', ws => {
    ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe') ws.subscribedMarket = msg.market;
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Live"));