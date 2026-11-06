// server.js
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { AccessToken } = require('livekit-server-sdk');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from /public
app.use(express.static('public'));

// ─── LiveKit endpoints (Phase 3) ───────────────────────────────
// /livekit/config  — public: returns just the LIVEKIT_URL so the client
//                    knows which SFU to talk to.
// /livekit/token   — mints a signed JWT for ?room=X&identity=Y. The API
//                    secret never leaves the server; the client only ever
//                    sees the resulting short-lived token.
app.get('/livekit/config', (req, res) => {
    res.json({ url: process.env.LIVEKIT_URL });
});

app.get('/livekit/token', async (req, res) => {
    const room = req.query.room || 'sop-sync-room';
    const identity = req.query.identity || `anon-${Date.now()}`;
    try {
        const at = new AccessToken(
            process.env.LIVEKIT_API_KEY,
            process.env.LIVEKIT_API_SECRET,
            { identity, ttl: '2h' }
        );
        at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true });
        const token = await at.toJwt();
        res.json({ token, url: process.env.LIVEKIT_URL, room, identity });
    } catch (err) {
        console.error('Token mint error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ─── Existing WebSocket signaling: 2-client room, A/B roles ────
let clients = [];

wss.on('connection', (ws) => {
    if (clients.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        ws.close();
        return;
    }

    // Assign whichever role is MISSING, not just based on count — otherwise
    // if A disconnects + reconnects while B is still here, A becomes B too
    // and the leader-position broadcast loop never starts on either side.
    const takenRoles = clients.map(c => c.role);
    const role = ['A', 'B'].find(r => !takenRoles.includes(r));
    clients.push({ ws, role });
    console.log(`Client ${role} connected. Total: ${clients.length}`);

    ws.send(JSON.stringify({ type: 'role', role }));

    if (clients.length === 2) {
        clients[0].ws.send(JSON.stringify({ type: 'start' }));
    }

    ws.on('message', (message) => {
        const other = clients.find(c => c.ws !== ws);
        if (other) {
            other.ws.send(message.toString());
            console.log(`Relayed message from ${role}: ${message.toString().slice(0, 100)}`);
        }
    });

    ws.on('close', () => {
        clients = clients.filter(c => c.ws !== ws);
        console.log(`Client ${role} disconnected. Total: ${clients.length}`);
    });
});

const PORT = 3000;
server.listen(PORT, () => {
    console.log(`Signaling server running on http://localhost:${PORT}`);
    console.log(`LiveKit URL: ${process.env.LIVEKIT_URL || '<NOT SET>'}`);
});
