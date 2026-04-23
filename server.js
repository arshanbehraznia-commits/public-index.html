const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// 🔥 SERVE FRONTEND
app.use(express.static('public'));

// 🔥 FIX ROUTES (IMPORTANT)
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/control.html', (req, res) => {
    res.sendFile(__dirname + '/public/control.html');
});

let tiktok = null;
let connected = false;

let bids = {};
let avatars = {};
let participants = new Set();

let timer = 60;
let running = false;
let inSnipe = false;

const SNIPE_TIME = 20;

// 🔁 TIMER LOOP
setInterval(() => {
    if (!running) return;

    if (timer > 0) timer--;

    if (timer === 0 && !inSnipe) {
        inSnipe = true;
        timer = SNIPE_TIME;
    } 
    else if (timer === 0 && inSnipe) {
        running = false;

        const sorted = Object.entries(bids)
            .sort((a,b)=>b[1]-a[1]);

        if (sorted.length > 0) {
            io.emit('winner', sorted[0]);
        }
    }

    io.emit('update', {
        bids,
        avatars,
        timer,
        count: participants.size,
        inSnipe
    });

}, 1000);

// 🔗 SOCKET
io.on('connection', socket => {

    socket.on('connectTikTok', async (username) => {

        if (connected && tiktok) {
            socket.emit('connected');
            return;
        }

        try {
            tiktok = new WebcastPushConnection(username);

            await tiktok.connect();
            connected = true;

            console.log("TikTok connected");

            socket.emit('connected');

            // 🎁 GIFTS
            tiktok.on('gift', data => {

                if (!running) return;

                const user = data.uniqueId;
                const coins = data.diamondCount;

                const avatar =
                    data.profilePictureUrl ||
                    data.userDetails?.profilePicture?.urls?.[0] ||
                    "";

                if (!bids[user]) bids[user] = 0;
                bids[user] += coins;

                avatars[user] = avatar;
                participants.add(user);

                io.emit('update', {
                    bids,
                    avatars,
                    timer,
                    count: participants.size,
                    inSnipe
                });
            });

            // 🔁 AUTO RECONNECT
            tiktok.on('disconnected', async () => {
                connected = false;
                console.log("Reconnecting...");

                while (!connected) {
                    try {
                        await tiktok.connect();
                        connected = true;
                        console.log("Reconnected");
                    } catch {
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
            });

        } catch (err) {
            console.log("Connection failed", err);
        }
    });

    // ▶ START
    socket.on('start', () => {
        bids = {};
        avatars = {};
        participants.clear();

        timer = 60;
        running = true;
        inSnipe = false;

        io.emit('update', {
            bids,
            avatars,
            timer,
            count: 0,
            inSnipe: false
        });
    });

    // 🔁 RESET
    socket.on('reset', () => {
        bids = {};
        avatars = {};
        participants.clear();

        timer = 60;
        running = false;
        inSnipe = false;

        io.emit('update', {
            bids: {},
            avatars: {},
            timer: 60,
            count: 0,
            inSnipe: false
        });
    });

    // ⏸ PAUSE
    socket.on('pause', () => {
        running = false;
    });

    // ▶ RESUME
    socket.on('resume', () => {
        running = true;
    });

    // ➕ ADD TIME
    socket.on('addTime', (t) => {
        timer += Number(t);
    });

    socket.on('removeTime', (t) => {
        timer = Math.max(0, timer - Number(t));
    });

    // ➕ ADD COINS
    socket.on('addCoins', ({user, amount}) => {

        if (!user || !amount) return;

        if (!bids[user]) bids[user] = 0;
        bids[user] += Number(amount);

        participants.add(user);

        if (!avatars[user]) avatars[user] = "";

        io.emit('update', {
            bids,
            avatars,
            timer,
            count: participants.size,
            inSnipe
        });
    });

    // ➖ REMOVE COINS
    socket.on('removeCoins', ({user, amount}) => {

        if (!bids[user]) return;

        bids[user] -= Number(amount);

        if (bids[user] <= 0) {
            delete bids[user];
            participants.delete(user);
        }

        io.emit('update', {
            bids,
            avatars,
            timer,
            count: participants.size,
            inSnipe
        });
    });

});

server.listen(3001, () => {
    console.log("Running on http://localhost:3001");
});
