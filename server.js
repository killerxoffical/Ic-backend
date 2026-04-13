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
    projectId: "ictex-trade"
};

if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();

const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const markets = {};
const marketTargets = {};

// ১. অ্যাডমিন থেকে মার্কেট লিস্ট শোনা
db.ref('admin/markets').on('value', (snapshot) => {
    const fbMarkets = snapshot.val() || {};
    Object.keys(fbMarkets).forEach((id) => {
        if (!markets[id]) {
            console.log("Starting Engine for: " + id);
            initializeMarket(id);
        }
    });
});

// ২. অ্যাডমিন থেকে কমান্ড শোনা
db.ref('admin/market_targets').on('value', (snapshot) => {
    const targets = snapshot.val() || {};
    Object.keys(marketTargets).forEach(k => delete marketTargets[k]);
    Object.assign(marketTargets, targets);
});

async function initializeMarket(id) {
    const path = id.replace(/[\.\/ ]/g, '-').toLowerCase();
    markets[id] = {
        id: id,
        path: path,
        currentPrice: 1.1500,
        history: [{ timestamp: Date.now(), open: 1.1500, high: 1.1505, low: 1.1495, close: 1.1500 }]
    };
}

// ৩. মেইন লুপ (প্রতি ১ সেকেন্ডে ফায়ারবেসে দাম পাঠানো)
setInterval(() => {
    const now = Date.now();
    const period = Math.floor(now / 60000) * 60000;

    for (const id in markets) {
        const m = markets[id];
        let lastC = m.history[m.history.length - 1];

        // নতুন ক্যান্ডেল তৈরি
        if (period > lastC.timestamp) {
            let newC;
            if (marketTargets[id]) {
                newC = { ...marketTargets[id], timestamp: period };
                db.ref(`admin/market_targets/${id}`).remove();
                delete marketTargets[id];
            } else {
                const open = lastC.close;
                newC = { timestamp: period, open: open, high: open + 0.0002, low: open - 0.0002, close: open + 0.0001 };
            }
            m.history.push(newC);
            if (m.history.length > 1500) m.history.shift();
            lastC = newC;
        }

        // দাম ওঠানামা করানো (Random Walk)
        m.currentPrice = lastC.close + (Math.random() - 0.5) * 0.0001;
        
        // ফায়ারবেসে দাম পাঠানো (যাতে অ্যাডমিন প্যানেলে দেখা যায়)
        db.ref(`markets/${m.path}/live`).set({
            price: parseFloat(m.currentPrice.toFixed(5)),
            timestamp: now
        });

        // WebSocket এ ডাটা পাঠানো (ইউজারদের জন্য)
        const payload = JSON.stringify({ market: id, candle: { ...lastC, close: m.currentPrice } });
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.subscribedMarket === id) client.send(payload);
        });
    }
}, 1000);

wss.on('connection', ws => {
    ws.on('message', raw => {
        const msg = JSON.parse(raw);
        if (msg.type === 'subscribe') ws.subscribedMarket = msg.market;
    });
});

app.get('/ping', (req, res) => res.send("Running..."));
server.listen(process.env.PORT || 3000);