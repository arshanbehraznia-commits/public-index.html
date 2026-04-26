const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    pingInterval: 25000,
    pingTimeout: 60000
});

// 🔥 SERVE FRONTEND
app.use(express.static('public'));

// 🔥 FIX ROUTES
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/index.html', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/control.html', (req, res) => {
    res.sendFile(__dirname + '/public/control.html');
});

let tiktok = null;
let connected = false;
let currentUsername = null;

let bids = {};
let avatars = {};
let participants = new Set();

let timer = 60;
let running = false;
let inSnipe = false;

const SNIPE_TIME = 20;
const recentGifts = new Set();

function sendUpdate(){
    io.emit('update', {
        bids,
        avatars,
        timer,
        count: participants.size,
        inSnipe
    });
}

function addCoinsToUser(user, amount, avatar = ""){
    if (!user || !amount) return;

    if (!bids[user]) bids[user] = 0;
    bids[user] += Number(amount);

    participants.add(user);

    if (avatar) avatars[user] = avatar;
    if (!avatars[user]) avatars[user] = "";

    sendUpdate();
}

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

    sendUpdate();

}, 1000);

async function connectToTikTok(username, socket){
    currentUsername = username;

    try {
        if (tiktok) {
            try {
                tiktok.removeAllListeners('gift');
                tiktok.removeAllListeners('disconnected');
                tiktok.removeAllListeners('streamEnd');
            } catch {}
        }

        tiktok = new WebcastPushConnection(username);

        await tiktok.connect();
        connected = true;

        console.log("TikTok connected:", username);

        if (socket) socket.emit('connected');

        // 🎁 GIFTS
        tiktok.on('gift', data => {
            console.log(
                "GIFT:",
                data.uniqueId,
                data.giftName,
                "diamonds:",
                data.diamondCount,
                "repeat:",
                data.repeatCount,
                "repeatEnd:",
                data.repeatEnd
            );

            if (!running) {
                console.log("Gift ignored because auction is not running");
                return;
            }

            const user = data.uniqueId;

            const avatar =
                data.profilePictureUrl ||
                data.userDetails?.profilePicture?.urls?.[0] ||
                "";

            // Prevent exact duplicate events being counted twice
            const giftKey =
                data.msgId ||
                data.messageId ||
                `${data.uniqueId}-${data.giftId}-${data.diamondCount}-${data.repeatCount}-${data.repeatEnd}-${data.createTime || data.timestamp || Date.now()}`;

            if (recentGifts.has(giftKey)) {
                console.log("Duplicate gift ignored");
                return;
            }

            recentGifts.add(giftKey);
            setTimeout(() => recentGifts.delete(giftKey), 60000);

            // For streak gifts, wait until streak ends so it counts once properly
            if (data.giftType === 1 && data.repeatEnd === false) {
                console.log("Waiting for streak gift to finish");
                return;
            }

            let coins = Number(data.diamondCount || 1);

            // If TikTok sends a streak gift final packet, use diamondCount raw if it already includes total.
            // If your terminal shows wrong values after testing, we can adjust this line.
            if (!coins || coins < 1) coins = 1;

            addCoinsToUser(user, coins, avatar);
        });

        // 🔁 AUTO RECONNECT
        tiktok.on('disconnected', async () => {
            connected = false;
            console.log("TikTok disconnected. Reconnecting...");

            while (!connected && currentUsername) {
                try {
                    await new Promise(r => setTimeout(r, 3000));
                    await connectToTikTok(currentUsername);
                } catch (err) {
                    console.log("Reconnect failed, retrying...");
                }
            }
        });

        tiktok.on('streamEnd', () => {
            connected = false;
            console.log("TikTok stream ended");
        });

    } catch (err) {
        connected = false;
        console.log("Connection failed", err);
        if (socket) socket.emit('failed');
    }
}

// 🔗 SOCKET
io.on('connection', socket => {

    console.log("Browser connected:", socket.id);
    sendUpdate();

    socket.on('disconnect', () => {
        console.log("Browser disconnected:", socket.id);
    });

    socket.on('connectTikTok', async (username) => {

        if (connected && tiktok) {
            socket.emit('connected');
            return;
        }

        await connectToTikTok(username, socket);
    });

    // ▶ START
    socket.on('start', () => {
        bids = {};
        avatars = {};
        participants.clear();
        recentGifts.clear();

        timer = 60;
        running = true;
        inSnipe = false;

        sendUpdate();
    });

    // 🔁 RESET
    socket.on('reset', () => {
        bids = {};
        avatars = {};
        participants.clear();
        recentGifts.clear();

        timer = 60;
        running = false;
        inSnipe = false;

        sendUpdate();
    });

    // ⏸ PAUSE
    socket.on('pause', () => {
        running = false;
        sendUpdate();
    });

    // ▶ RESUME
    socket.on('resume', () => {
        running = true;
        sendUpdate();
    });

    // ➕ ADD TIME
    socket.on('addTime', (t) => {
        timer += Number(t);
        if (timer < 0) timer = 0;
        sendUpdate();
    });

    socket.on('removeTime', (t) => {
        timer = Math.max(0, timer - Number(t));
        sendUpdate();
    });

    // ➕ ADD COINS
    socket.on('addCoins', ({user, amount}) => {
        addCoinsToUser(user, Number(amount), avatars[user] || "");
    });

    // ➖ REMOVE COINS
    socket.on('removeCoins', ({user, amount}) => {

        if (!bids[user]) return;

        bids[user] -= Number(amount);

        if (bids[user] <= 0) {
            delete bids[user];
            participants.delete(user);
        }

        sendUpdate();
    });

});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
    console.log("Running on port " + PORT);
});
