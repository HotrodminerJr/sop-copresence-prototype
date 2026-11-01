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
const offsetText   = document.getElementById('offsetText'); // Added to support the offset UI update
const burstText    = document.getElementById('burstText');  // Burst progress + best-of-N selection UI
const positionText = document.getElementById('positionText'); // Local playback position (both peers)
const expectedText = document.getElementById('expectedText'); // Expected position from leader broadcast (B only)
const driftText    = document.getElementById('driftText');    // P_local − P_expected (B only)
const injectBtn    = document.getElementById('injectBtn');    // Drift injection button (B only)
const downloadBtn  = document.getElementById('downloadBtn');  // Download drift CSV button (B only)
const clearBtn     = document.getElementById('clearBtn');     // Clear drift log button (B only)
const rowCountText = document.getElementById('rowCountText'); // Displays current row count in the drift buffer
const rateText     = document.getElementById('rateText');     // Current playback rate (sub-phase 2.5)
const modeText     = document.getElementById('modeText');     // Current correction mode (sub-phase 2.5)
const videoLagText = document.getElementById('videoLagText'); // model − video.currentTime (α instrumentation)
const video        = document.getElementById('video');        // Real <video> element (zeroth step)
const playBtn      = document.getElementById('playBtn');      // Leader-only play button (zeroth step)
const sendBtn      = document.getElementById('sendBtn');
const logDiv       = document.getElementById('log');

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

// ═══════════════════════════════════════════════════════════
// Cristian's Burst Sampling (Sub-phase 2.2)
// ═══════════════════════════════════════════════════════════
// Every BURST_INTERVAL_MS, peer B fires BURST_SIZE Cristian's
// requests, each SAMPLE_INTERVAL_MS apart. All responses are
// collected, then the sample with the LOWEST RTT is chosen as
// the best offset estimate for that burst.
//
// Why lowest-RTT-wins: the sample with lowest RTT happened during
// the least-congested moment, which is closest to Cristian's
// core assumption of symmetric network delay. See Theory Doc T5.
// ═══════════════════════════════════════════════════════════
const BURST_SIZE = 10;              // Samples per burst
const SAMPLE_INTERVAL_MS = 100;     // Gap between pings within a burst → burst duration ≈ 1s
const BURST_INTERVAL_MS = 10000;    // How often bursts fire
const BURST_TIMEOUT_MS = 3000;      // Give up on missing samples after this

// Burst state (peer B only)
let burstNumber = 0;
let currentBurst = null;   // { id, samples: [], startTime }

// ═══════════════════════════════════════════════════════════
// Leader-Follower Position Broadcast (Sub-phase 2.3)
// ═══════════════════════════════════════════════════════════
// A (leader) maintains a simulated "playback position" that ticks
// up 1000ms per real second. Every BROADCAST_INTERVAL_MS, A sends
// its {position, leader_clock} to B.
//
// B (follower) independently ticks its own local position. On each
// broadcast, B computes:
//    T_leader_in_B  = leader_clock − θ    (convert A's clock to B's)
//    Δt             = T_receive − T_leader_in_B    (network delay)
//    P_expected     = leader_position + Δt
//    drift          = P_local − P_expected
//
// θ (estimatedOffset) is updated after each Cristian's burst.
// ═══════════════════════════════════════════════════════════
const POSITION_TICK_MS = 100;          // How often we refresh the local position display
const BROADCAST_INTERVAL_MS = 500;     // Leader broadcast cadence

// Position model with variable playback rate (sub-phase 2.5).
// Three-field checkpoint model that supports a mutable rate — maps 1:1 to
// HTML5 <video>.playbackRate / expo-av playbackRate for the Week 6 port.
//   checkpointWall  — wall-clock timestamp of the last checkpoint
//   checkpointPos   — playhead position at that moment
//   currentRate     — ms of playback per ms of wall-clock (default 1.0)
// To change rate without a visible seek: stamp a new checkpoint at the
// CURRENT position with the new rate. The past timeline stays intact.
let checkpointWall = null;
let checkpointPos  = 0;
let currentRate    = 1.0;

function setCheckpoint(pos, rate) {
    checkpointWall = Date.now();
    checkpointPos  = pos;
    currentRate    = rate;
}

// Returns the current local position in ms. 0 if not started yet.
function currentPosition() {
    if (checkpointWall === null) return 0;
    return checkpointPos + (Date.now() - checkpointWall) * currentRate;
}

// Follower-only: latest offset estimate θ from Cristian's, and whether we have one yet.
let estimatedOffset = 0;
let hasOffset = false;

// ═══════════════════════════════════════════════════════════
// Drift Logging to CSV (Sub-phase 2.4)
// ═══════════════════════════════════════════════════════════
// Every leader-position broadcast reception on B appends one row
// to an in-memory buffer. Buffer is downloadable as a .csv at any
// time via the "Download drift CSV" button. Data feeds offline
// analysis (pandas + matplotlib) for the drift-over-time plots
// required in the evaluation phase.
// ═══════════════════════════════════════════════════════════
const CSV_HEADERS = [
    'timestamp_ms',            // Date.now() when B computed this drift row
    'burst_offset_ms',         // latest θ from Cristian's
    'sample_rtt_ms',           // RTT of the last-completed burst's best sample
    'leader_position_ms',      // from the broadcast
    'expected_position_ms',    // computed on B: leader_position + Δt
    'local_position_ms',       // B's actual local position at that moment
    'drift_ms',                // local − expected (MODEL drift — the sync protocol's output)
    'correction_applied',      // 'none' | 'ease' | 'snap'
    'playback_rate',           // follower's rate during this row (1.00 / 1.02 / 0.98)
    'video_current_time_ms',   // follower's video.currentTime * 1000 at this broadcast (α)
    'video_vs_model_gap_ms'    // local_position_ms − video_current_time_ms: positive = video lagging model (α)
];

// In-memory row buffer (peer B only). Each row is a plain object matching CSV_HEADERS.
let driftLog = [];

// Track the last-completed burst's best sample RTT (updated inside finalizeBurst()).
// Broadcast rows record this so we can correlate drift with the freshness/quality
// of the underlying Cristian's estimate.
let lastBurstRtt = null;

function appendDriftRow(row) {
    driftLog.push(row);
    rowCountText.textContent = driftLog.length;
}

// Serialize the buffer to CSV text and trigger a browser download via Blob URL.
// Filename is ISO-timestamped so multiple test runs don't collide.
function downloadCSV() {
    if (driftLog.length === 0) {
        log('Drift log is empty — nothing to download');
        return;
    }

    // Build CSV text: header row + data rows.
    const lines = [CSV_HEADERS.join(',')];
    for (const row of driftLog) {
        lines.push([
            row.timestamp_ms,
            row.burst_offset_ms.toFixed(2),
            row.sample_rtt_ms ?? '',       // may be null before first burst completes
            row.leader_position_ms,
            row.expected_position_ms.toFixed(1),
            row.local_position_ms.toFixed(1),
            row.drift_ms.toFixed(1),
            row.correction_applied,
            row.playback_rate.toFixed(3),
            row.video_current_time_ms.toFixed(1),
            row.video_vs_model_gap_ms.toFixed(1)
        ].join(','));
    }
    const csvText = lines.join('\n');

    // Timestamped filename: sop-drift-2026-09-16T18-31-42.csv
    const iso = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `sop-drift-${iso}.csv`;

    // Create Blob, allocate object URL, wire it to a hidden <a>, click it.
    // Browser handles the file save prompt from there.
    const blob = new Blob([csvText], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`Downloaded ${driftLog.length} rows → ${filename}`);
}

// Empties the buffer. Useful between demo scenarios (clean baseline → inject → download → clear → next).
function clearDriftLog() {
    const n = driftLog.length;
    driftLog = [];
    rowCountText.textContent = 0;
    log(`Cleared drift log (${n} rows discarded)`);
}

function startBurst() {
    burstNumber++;
    currentBurst = {
        id: burstNumber,
        samples: [],
        startTime: Date.now()
    };

    log(`Burst #${burstNumber}: firing ${BURST_SIZE} samples`);
    burstText.textContent = `#${burstNumber}: 0/${BURST_SIZE} received`;

    // Fire BURST_SIZE pings, each SAMPLE_INTERVAL_MS apart.
    // Each ping is tagged with burstId + sampleIndex so B can correlate
    // pongs back to the burst they came from (in case timing shifts).
    for (let i = 0; i < BURST_SIZE; i++) {
        setTimeout(() => {
            if (dc.readyState === 'open' && currentBurst && currentBurst.id === burstNumber) {
                dc.send(JSON.stringify({
                    type: 'ping',
                    t1: Date.now(),
                    burstId: currentBurst.id,
                    sampleIndex: i
                }));
            }
        }, i * SAMPLE_INTERVAL_MS);
    }

    // Timeout safeguard: if some samples never arrive, finalize with what we have.
    const thisBurstId = burstNumber;
    setTimeout(() => {
        if (currentBurst && currentBurst.id === thisBurstId) {
            log(`Burst #${thisBurstId}: timeout with ${currentBurst.samples.length}/${BURST_SIZE} samples`);
            finalizeBurst();
        }
    }, BURST_SIZE * SAMPLE_INTERVAL_MS + BURST_TIMEOUT_MS);
}

function finalizeBurst() {
    if (!currentBurst) return;

    const burstId = currentBurst.id;
    const samples = currentBurst.samples;

    if (samples.length === 0) {
        log(`Burst #${burstId}: NO SAMPLES received — network problem?`);
        burstText.textContent = `#${burstId}: FAILED (0/${BURST_SIZE})`;
        currentBurst = null;
        return;
    }

    // Select the sample with the lowest RTT — closest to symmetric network delay,
    // therefore the most reliable offset estimate.
    // .reduce with `(a, b) => a.rtt < b.rtt ? a : b` finds the min-RTT element.
    const best = samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
    const minRtt = Math.min(...samples.map(s => s.rtt));
    const maxRtt = Math.max(...samples.map(s => s.rtt));

    // Update UI with the best-of-burst offset.
    offsetText.textContent = best.offset.toFixed(1);
    burstText.textContent =
        `#${burstId}: ${samples.length}/${BURST_SIZE} — RTT [${minRtt}, ${maxRtt}] ms — best offset ${best.offset.toFixed(1)} ms`;

    log(`Burst #${burstId} done: ${samples.length}/${BURST_SIZE}, RTT range [${minRtt}, ${maxRtt}]ms, chose offset ${best.offset.toFixed(1)}ms`);

    // The follower keeps the latest offset for use in the position reconciliation math.
    estimatedOffset = best.offset;
    hasOffset = true;

    // Also record the best sample's RTT so drift rows can log the freshness of the
    // Cristian's estimate that produced this offset.
    lastBurstRtt = best.rtt;

    currentBurst = null;
}

// ═══════════════════════════════════════════════════════════
// Snap / Ease Correction (Sub-phase 2.5)
// ═══════════════════════════════════════════════════════════
// Called from the leader-position handler after drift is computed.
// Decides whether to snap, ease, or no-op, mutates the position model
// accordingly, and returns a label for the CSV row.
//
// Thresholds (D5 + D15 hysteresis):
//   |drift| ≥ 500ms  → SNAP  (seek, correctness over smoothness)
//   enter ease at 50ms, exit at 30ms (asymmetric to avoid chatter)
//   ease rate: 1.02 if behind leader, 0.98 if ahead
//
// Sign convention: drift = local − expected
//   drift > 0  →  B is ahead  →  slow down (rate 0.98)
//   drift < 0  →  B is behind →  speed up (rate 1.02)
//
// Guard: don't apply any correction before Cristian's has a valid θ,
// otherwise we'd react to drift computed with an uninitialized offset.
// ═══════════════════════════════════════════════════════════
const SNAP_THRESHOLD_MS      = 500;
const EASE_ENTER_MS          = 50;
const EASE_EXIT_MS           = 30;    // hysteresis — exit tighter than enter
const EASE_RATE_MAGNITUDE    = 0.02;  // ±2%

let easing = false;

// ═══════════════════════════════════════════════════════════
// Real video hookup (zeroth step before Phase 3)
// ═══════════════════════════════════════════════════════════
// Hooks the position model to an HTML5 <video> element.
// - Both peers load the same MP4, muted, paused.
// - Leader has a Play button; clicking it starts leader's video,
//   stamps the model at 0, and sends a 'play' message so follower
//   starts simultaneously.
// - Follower's correction logic now ALSO drives the video:
//     snap → video.currentTime = expected/1000, playbackRate = 1.0
//     ease → video.playbackRate = currentRate (0.98 or 1.02)
// - Model stays authoritative; video is driven from it (Option Z).
// ═══════════════════════════════════════════════════════════
const VIDEO_URL = '/sample.mp4';   // served from public/, 30s MP4
let videoPlaying = false;

// Push the follower's model state to its <video>. Called from applyCorrection
// after every snap/ease transition. No-op if video hasn't started yet.
function syncVideoRate() {
    if (!videoPlaying) return;
    if (video.playbackRate !== currentRate) {
        video.playbackRate = currentRate;
    }
}
function seekVideoTo(positionMs) {
    if (!videoPlaying) return;
    video.currentTime = positionMs / 1000;
}

function applyCorrection(drift, expected) {
    if (!hasOffset) return 'none';   // no reliable θ yet

    const absD = Math.abs(drift);

    if (absD >= SNAP_THRESHOLD_MS) {
        setCheckpoint(expected, 1.0);
        seekVideoTo(expected);
        syncVideoRate();
        easing = false;
        log(`SNAP: drift ${drift.toFixed(0)}ms → seek to expected ${expected.toFixed(0)}ms`);
        return 'snap';
    }

    if (easing) {
        // Already easing — exit when drift has shrunk below the lower threshold.
        if (absD < EASE_EXIT_MS) {
            setCheckpoint(currentPosition(), 1.0);
            syncVideoRate();
            easing = false;
            log(`EASE exit: drift ${drift.toFixed(0)}ms < ${EASE_EXIT_MS}ms, rate back to 1.00`);
            return 'none';
        }
        // Still easing — direction may have flipped if B overshot; update rate.
        const desired = drift > 0 ? 1 - EASE_RATE_MAGNITUDE : 1 + EASE_RATE_MAGNITUDE;
        if (desired !== currentRate) {
            setCheckpoint(currentPosition(), desired);
            syncVideoRate();
        }
        return 'ease';
    }

    // Not currently easing — enter if drift has grown past the upper threshold.
    if (absD >= EASE_ENTER_MS) {
        const desired = drift > 0 ? 1 - EASE_RATE_MAGNITUDE : 1 + EASE_RATE_MAGNITUDE;
        setCheckpoint(currentPosition(), desired);
        syncVideoRate();
        easing = true;
        log(`EASE enter: drift ${drift.toFixed(0)}ms → rate ${desired}`);
        return 'ease';
    }

    // Inside the dead zone — do nothing.
    return 'none';
}

// --- DataChannel setup (both A and B call this) ---
function setupDataChannel() {
    // Fires when the DataChannel is fully open on this side.
    dc.onopen = () => {
        log('DataChannel OPEN — P2P connection live!');
        statusText.textContent = 'Connected P2P';
        sendBtn.disabled = false;

        // Both peers start their local playback position ticker at the same instant.
        // Position comes from the checkpoint model (sub-phase 2.5); stamp an initial
        // checkpoint at pos=0 with rate=1.0, then tick the display every 100ms.
        setCheckpoint(0, 1.0);
        setInterval(() => {
            positionText.textContent = Math.round(currentPosition());
            // α: live video-vs-model lag readout, so the demo shows the codec
            // seek recovery visibly without waiting for the next broadcast.
            if (videoPlaying) {
                const gap = currentPosition() - video.currentTime * 1000;
                videoLagText.textContent = gap.toFixed(0);
            }
        }, POSITION_TICK_MS);

        // Zeroth step: load the video on both peers (muted, paused). Leader gets
        // the Play button; follower waits for the 'play' message.
        video.src = VIDEO_URL;
        video.load();
        if (role === 'A') {
            playBtn.disabled = false;
        }
        log(`Position ticker started at t=0`);

        if (role === 'A') {
            // === Peer A (leader) ===
            log('I am the leader — echoing ping requests + broadcasting position');
            // Broadcast leader position every BROADCAST_INTERVAL_MS.
            setInterval(() => {
                if (dc.readyState === 'open') {
                    dc.send(JSON.stringify({
                        type: 'leader-position',
                        position: currentPosition(),
                        leader_clock: Date.now()      // A's clock at moment of sample
                    }));
                }
            }, BROADCAST_INTERVAL_MS);
        } else {
            // === Peer B (follower) ===
            log(`I am the follower — starting Cristian's burst sync (${BURST_SIZE} samples every ${BURST_INTERVAL_MS/1000}s)`);
            injectBtn.disabled = false;      // Only B can inject drift
            downloadBtn.disabled = false;    // Only B has a drift log to download
            clearBtn.disabled = false;       // Only B has a drift log to clear
            // Fire the first burst immediately for a fast initial offset estimate.
            startBurst();
            // Then fire a new burst every BURST_INTERVAL_MS.
            setInterval(() => {
                if (dc.readyState === 'open') startBurst();
            }, BURST_INTERVAL_MS);
        }
    };

    // Fires whenever the peer sends us a DataChannel message.
    dc.onmessage = (event) => {
        const msg = JSON.parse(event.data);

        if (msg.type === 'ping') {
            // === Peer A's role: echo the request with T2, T3 timestamps ===
            // T2 = A's clock at receive.
            const t2 = Date.now();
            // T3 = A's clock at send. In practice these are the same millisecond
            // on localhost, but we still measure separately for correctness.
            // (In real deployment, if A had to do work between receive and send,
            // T3 - T2 would be non-negligible processing time.)
            dc.send(JSON.stringify({
                type: 'pong',
                t1: msg.t1,                    // echo B's original T1 unchanged
                t2: t2,                        // A's clock at receive
                t3: Date.now(),                // A's clock at send
                burstId: msg.burstId,          // echo back so B can correlate
                sampleIndex: msg.sampleIndex   // echo back so B knows which sample
            }));
        }
        else if (msg.type === 'pong') {
            // === Peer B's role: process the reply ===
            const t4 = Date.now();
            const { t1, t2, t3, burstId, sampleIndex } = msg;

            // RTT net of A's processing time between receive (T2) and send (T3).
            // Formula: RTT = (T4 - T1) - (T3 - T2)
            //        = total elapsed on B's side − time A spent holding the message
            const rtt = (t4 - t1) - (t3 - t2);

            // Cristian's offset formula (derivation in Theory Doc T5):
            //   θ = ((T2 - T1) + (T3 - T4)) / 2
            // Positive θ = A's clock is AHEAD of B's clock by θ ms.
            const offset = ((t2 - t1) + (t3 - t4)) / 2;

            // Show every arriving sample's raw RTT — visible network activity per ping.
            rttText.textContent = rtt;

            // If this pong belongs to the current burst, record the sample.
            if (currentBurst && burstId === currentBurst.id) {
                currentBurst.samples.push({ rtt, offset, sampleIndex });
                burstText.textContent = `#${currentBurst.id}: ${currentBurst.samples.length}/${BURST_SIZE} received`;

                // All samples in → finalize immediately (don't wait for timeout).
                if (currentBurst.samples.length === BURST_SIZE) {
                    finalizeBurst();
                }
            }
        }
        else if (msg.type === 'leader-position') {
            // === Peer B's role: compute expected position, compare to local ===
            // Leader broadcasts { position, leader_clock }. B computes where it
            // *should* be right now given the leader's state and network delay.
            const t_receive = Date.now();                          // B's clock at receive
            const leaderPos = msg.position;                        // A's playback position
            const leaderClock = msg.leader_clock;                  // A's clock when it sampled

            // Convert leader's clock reading into B's clock.
            // θ (estimatedOffset) = A's clock − B's clock.
            //   → A_time_in_B_clock = A_time − θ
            const leaderClockInB = leaderClock - estimatedOffset;

            // Δt = elapsed time (in B's clock) since the leader sampled its position.
            // This is essentially the one-way network delay.
            const deltaT = t_receive - leaderClockInB;

            // Expected position: where B *should* be right now.
            // = leader position at the moment it broadcast + elapsed time since then.
            const expected = leaderPos + deltaT;

            // Drift = my local position − where I should be.
            //   positive drift = I am AHEAD of the leader
            //   negative drift = I am BEHIND
            const local = currentPosition();
            const drift = local - expected;

            expectedText.textContent = expected.toFixed(0);
            driftText.textContent = drift.toFixed(0);

            // Color-code the drift for visual signal during demo:
            //   green: within perceptual dead-zone
            //   yellow: correctable via easing
            //   red: needs a snap correction
            const absD = Math.abs(drift);
            driftText.className = absD < 50 ? 'drift-good'
                                : absD < 500 ? 'drift-warn'
                                : 'drift-bad';

            // Decide + apply correction (sub-phase 2.5), then log the row with
            // the correction label and the rate the follower is now running at.
            const correction = applyCorrection(drift, expected);
            rateText.textContent = currentRate.toFixed(2);
            modeText.textContent = correction;

            // α instrumentation: measure the gap between the MODEL (sync protocol's
            // output) and the actual video playhead. This is 0ms during steady
            // playback, several hundred ms right after a snap while the decoder
            // re-seeks, and gives us the user-visible drift vs the protocol-level
            // drift already recorded in drift_ms.
            const videoTimeMs = videoPlaying ? video.currentTime * 1000 : 0;
            const videoGap = videoPlaying ? (local - videoTimeMs) : 0;

            appendDriftRow({
                timestamp_ms: t_receive,
                burst_offset_ms: estimatedOffset,
                sample_rtt_ms: lastBurstRtt,
                leader_position_ms: leaderPos,
                expected_position_ms: expected,
                local_position_ms: local,
                drift_ms: drift,
                correction_applied: correction,
                playback_rate: currentRate,
                video_current_time_ms: videoTimeMs,
                video_vs_model_gap_ms: videoGap
            });
        }
        else if (msg.type === 'play') {
            // Follower receives leader's play signal — start video + align model.
            // Model gets stamped at 0 so both peers' models start from the same
            // zero point; the first leader-position broadcast will push the
            // follower to the leader's actual position within one broadcast cycle.
            if (role === 'B') {
                video.play().catch(err => log(`B play() rejected: ${err.message}`));
                videoPlaying = true;
                setCheckpoint(0, 1.0);
                log('Received play from leader — video started on follower');
            }
        }
        else if (msg.type === 'chat') {
            log(`Peer says: ${msg.text}`);
        }
    };

    dc.onclose = () => {
        log('DataChannel CLOSED');
        sendBtn.disabled = true;
        injectBtn.disabled = true;
    };
}

// --- Drift injection (peer B only, for demo purposes) ---
// Moves the local position start time BACKWARD by INJECT_MS, which makes
// currentPosition() jump forward by INJECT_MS. Simulates a peer that has
// drifted ahead of the leader — useful for demonstrating the reconciliation
// logic in Phase 2.5 will actually correct measurable drift.
const INJECT_MS = 2000;
injectBtn.onclick = () => {
    if (checkpointWall !== null) {
        // Shift the playhead forward by INJECT_MS without changing rate —
        // simulates a follower that has drifted ahead of the leader.
        // Also seek the video forward so the drift is real (model AND video
        // both ahead), not just a model-only lie; otherwise the subsequent
        // snap would un-sync the video from the model.
        setCheckpoint(currentPosition() + INJECT_MS, currentRate);
        seekVideoTo(currentPosition());
        log(`Injected +${INJECT_MS}ms drift — local position jumped forward`);
    }
};

// Zeroth step: leader-only Play button. Starts leader's video, aligns the
// model to position 0, and tells the follower to start too.
playBtn.onclick = () => {
    if (role !== 'A' || !dc || dc.readyState !== 'open') return;
    video.play().catch(err => log(`A play() rejected: ${err.message}`));
    videoPlaying = true;
    setCheckpoint(0, 1.0);
    dc.send(JSON.stringify({ type: 'play' }));
    playBtn.disabled = true;
    log('Play triggered — leader + follower both start');
};

// Wire the download and clear buttons.
downloadBtn.onclick = downloadCSV;
clearBtn.onclick = clearDriftLog;

// --- Send button: send a plain chat message peer-to-peer ---
sendBtn.onclick = () => {
    if (dc && dc.readyState === 'open') {
        const text = `Hello from ${role} at ${new Date().toLocaleTimeString()}`;
        dc.send(JSON.stringify({ type: 'chat', text }));
        log(`I sent: ${text}`);
    }
};

log('Client script loaded');