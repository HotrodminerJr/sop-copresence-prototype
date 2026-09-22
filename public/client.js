// ═══════════════════════════════════════════════════════════
// SOP Prototype — WebRTC Client (Phase 1)
// Runs in the browser. Two tabs of this page connect P2P
// via WebRTC DataChannel, using the Node.js signaling server
// only for the initial handshake.
// ═══════════════════════════════════════════════════════════

// --- Grab references to UI elements defined in index.html ---
const statusText = document.getElementById('statusText');
const roleText   = document.getElementById('roleText');
const rttText    = document.getElementById('rttText');
const sendBtn    = document.getElementById('sendBtn');
const logDiv     = document.getElementById('log');

// Helper: append a timestamped line to the log div AND browser console.
function log(msg) {
    console.log(msg);
    const time = new Date().toISOString().slice(11, 23);  // just HH:MM:SS.mmm
    logDiv.innerHTML += `<div>[${time}] ${msg}</div>`;
    logDiv.scrollTop = logDiv.scrollHeight;               // auto-scroll to bottom
}

// --- Connect to the signaling server via WebSocket ---
// location.host is "localhost:3000" when browsing http://localhost:3000
const ws = new WebSocket(`ws://${location.host}`);

// State variables — set later during the WebRTC handshake
let role = null;   // 'A' or 'B', assigned by server
let pc   = null;   // RTCPeerConnection (the P2P link)
let dc   = null;   // RTCDataChannel (the message pipe on top of the P2P link)

// --- WebSocket event handlers ---
ws.onopen = () => {
    log('Connected to signaling server');
    statusText.textContent = 'Waiting for peer...';
};

ws.onclose = () => log('Signaling server disconnected');
ws.onerror = (e) => log(`WebSocket error: ${e.message || 'unknown'}`);

// This runs whenever the server sends us a message.
// The message tells us either our role, or that we should start,
// or contains WebRTC signaling data (offer/answer/ICE candidate).
ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    log(`Signaling: ${msg.type}`);
    
    switch (msg.type) {
        case 'role':
            // Server assigned us a role — either 'A' (initiator) or 'B' (responder).
            role = msg.role;
            roleText.textContent = role;
            log(`I am peer ${role}`);
            break;
            
        case 'start':
            // Server tells peer A: "both connected, you start the call."
            statusText.textContent = 'Starting WebRTC handshake...';
            await startCall();
            break;
            
        case 'offer':
            // Peer B receives A's SDP offer.
            statusText.textContent = 'Received offer, sending answer...';
            await handleOffer(msg.sdp);
            break;
            
        case 'answer':
            // Peer A receives B's SDP answer.
            statusText.textContent = 'Received answer, finalizing...';
            await handleAnswer(msg.sdp);
            break;
            
        case 'ice-candidate':
            // Both sides receive ICE candidates from the other, incrementally (Trickle ICE).
            if (pc && msg.candidate) {
                try {
                    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
                    log('Added ICE candidate');
                } catch (err) {
                    log(`ICE add error: ${err.message}`);
                }
            }
            break;
    }
};

// --- Create the RTCPeerConnection and set up its event handlers ---
function createPeerConnection() {
    // Configure with Google's public STUN server so ICE can discover our public IP.
    pc = new RTCPeerConnection({
        iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    // Fires each time ICE discovers a new candidate for THIS peer.
    // We forward each one to the other peer via the signaling server.
    pc.onicecandidate = (event) => {
        if (event.candidate) {
            ws.send(JSON.stringify({
                type: 'ice-candidate',
                candidate: event.candidate
            }));
        }
    };
    
    // Fires when the P2P connection state changes (useful for debugging).
    pc.onconnectionstatechange = () => {
        log(`PeerConnection state: ${pc.connectionState}`);
    };
    
    // Fires on the RECEIVING side (B) when A's DataChannel arrives.
    // B doesn't create the channel — B just accepts A's channel here.
    pc.ondatachannel = (event) => {
        dc = event.channel;
        setupDataChannel();
    };
}

// --- Peer A: creates the DataChannel and sends the offer ---
async function startCall() {
    createPeerConnection();
    
    // Only A creates the DataChannel; B receives it via pc.ondatachannel.
    dc = pc.createDataChannel('sync');
    setupDataChannel();
    
    // Build the SDP offer: "here's what I can do."
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    
    // Send the offer to B via signaling.
    ws.send(JSON.stringify({ type: 'offer', sdp: offer }));
    log('Sent offer to peer');
}

// --- Peer B: receives the offer, sends back an answer ---
async function handleOffer(sdp) {
    createPeerConnection();
    
    // Apply A's offer as our "remote description."
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    
    // Build our answer: "here's what I'll do given your offer."
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    
    // Send the answer back to A via signaling.
    ws.send(JSON.stringify({ type: 'answer', sdp: answer }));
    log('Sent answer to peer');
}

// --- Peer A: receives B's answer, completes the handshake ---
async function handleAnswer(sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    log('Handshake complete');
}

// --- DataChannel setup (both A and B call this) ---
function setupDataChannel() {
    // Fires when the DataChannel is fully open on this side.
    dc.onopen = () => {
        log('DataChannel OPEN — P2P connection live!');
        statusText.textContent = 'Connected P2P';
        sendBtn.disabled = false;
        
        // Start sending a ping every 1000ms to measure RTT.
        setInterval(() => {
            if (dc.readyState === 'open') {
                dc.send(JSON.stringify({ type: 'ping', t1: Date.now() }));
            }
        }, 1000);
    };
    
    // Fires whenever the peer sends us a DataChannel message.
    dc.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'ping') {
            // Echo back as pong with the original timestamp unchanged.
            dc.send(JSON.stringify({ type: 'pong', t1: msg.t1 }));
        } 
        else if (msg.type === 'pong') {
            // Compute RTT: how long the round trip took.
            const rtt = Date.now() - msg.t1;
            rttText.textContent = rtt;
            // Uncomment next line if you want RTT in the log too (noisy):
            // log(`RTT: ${rtt}ms`);
        } 
        else if (msg.type === 'chat') {
            log(`Peer says: ${msg.text}`);
        }
    };
    
    dc.onclose = () => {
        log('DataChannel CLOSED');
        sendBtn.disabled = true;
    };
}

// --- Send button: send a plain chat message peer-to-peer ---
sendBtn.onclick = () => {
    if (dc && dc.readyState === 'open') {
        const text = `Hello from ${role} at ${new Date().toLocaleTimeString()}`;
        dc.send(JSON.stringify({ type: 'chat', text }));
        log(`I sent: ${text}`);
    }
};

log('Client script loaded');