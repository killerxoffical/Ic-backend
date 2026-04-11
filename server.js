const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');
const firebase = require('firebase/app');
require('firebase/database');

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

// মার্কেট লোড
mainDb.ref('admin/markets').on('value', snapshot => {
    const data = snapshot.val() || {};
    Object.keys(data).forEach(id => {
        if (data[id].status === 'active' && !markets[id]) {
            markets[id] = { history: [{ timestamp: 0, open:1.15, high:1.15, low:1.15, close: 1.15500, path: new Array(1000).fill(1.155) }] };
        }
    });
});

function generateCandle(timestamp, open, type) {
    const vol = open * 0.0005;
    const body = vol * (0.8 + Math.random());
    const close = (type === "UP") ? open + body : open - body;
    const high = Math.max(open, close) + (vol * 0.2);
    const low = Math.min(open, close) - (vol * 0.2);
    const path = [];
    for (let i = 0; i < CANDLE_PATH_STEPS; i++) {
        let p = open + (close - open) * (i / 999);
        p += (Math.random() - 0.5) * (vol * 0.1);
        path.push(parseFloat(p.toFixed(5)));
    }
    return { timestamp, open, high, low, close, path, isForced: true };
}

setInterval(async () => {
    const now = Date.now();
    const period = Math.floor(now / TIMEFRAME) * TIMEFRAME;
    const elapsed = now - period;

    for (const id in markets) {
        const m = markets[id];
        let last = m.history[m.history.length - 1];

        if (period > last.timestamp) {
            const snap = await adminDb.ref(`candle_plans/${id}`).once('value');
            const plan = snap.val();
            let nextType = "UP";
            let idx = 0;

            if (plan) {
                idx = plan.currentIndex;
                if (idx >= 6) {
                    idx = 0;
                    await adminDb.ref(`candle_plans/${id}/currentIndex`).set(0);
                }
                nextType = plan.pattern[idx];
                await adminDb.ref(`candle_plans/${id}/currentIndex`).set(idx + 1);
            }

            const newC = generateCandle(period, last.close, nextType);
            m.history.push(newC);
            if (m.history.length > 50) m.history.shift();
            
            // মেইন ডিবির লাইভ প্রাইস আপডেট (Monitor এর জন্য)
            const path = String(id).replace(/[\.\/ ]/g, '-').toLowerCase();
            mainDb.ref(`markets/${path}/live`).set({ price: newC.open, timestamp: now });
        }

        const pIdx = Math.min(999, Math.floor((elapsed / TIMEFRAME) * 1000));
        const livePrice = m.history[m.history.length - 1].path[pIdx];
        
        const payload = JSON.stringify({
            type: 'subscribed', market: id,
            candle: { ...m.history[m.history.length - 1], close: livePrice }
        });

        wss.clients.forEach(c => {
            if (c.readyState === WebSocket.OPEN && c.subscribedMarket === id) c.send(payload);
        });
    }
}, 300);

wss.on('connection', ws => {
    ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe') ws.subscribedMarket = msg.market;
    });
});

server.listen(process.env.PORT || 3000);