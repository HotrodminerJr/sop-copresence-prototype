// server.js
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
//importing express for serving static files/http. node's built in http module and the ws library.
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files from /public
app.use(express.static('public'));

// Track connected clients. Simple 2-client model: first is 'A', second is 'B'.
let clients = [];

wss.on('connection', (ws) => {
    if (clients.length >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room full' }));
        ws.close();
        return;
    }
    
    const role = clients.length === 0 ? 'A' : 'B';
    clients.push({ ws, role });
    console.log(`Client ${role} connected. Total: ${clients.length}`);
    
    // Tell client its role
    ws.send(JSON.stringify({ type: 'role', role }));
    
    // If both clients are here, tell A to start the call
    if (clients.length === 2) {
        clients[0].ws.send(JSON.stringify({ type: 'start' }));
    }
    
    // Relay messages to the OTHER client
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
});