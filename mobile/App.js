// ═══════════════════════════════════════════════════════════
// SOP Co-Presence — React Native port, Phase 3
// ═══════════════════════════════════════════════════════════
// Phase 3 adds the sync engine on top of Phase 2's DataChannel:
//   - Cristian's burst sampling (follower only)
//   - Leader-follower position broadcast (leader only)
//   - Checkpoint + rate position model (D14)
//   - Snap / ease / no-op reconciliation with hysteresis (D5/D15)
//   - In-memory drift log (CSV download deferred)
//
// Code is a faithful translation of public/client.js — all
// thresholds and semantics match. Refs hold rapidly-updating
// state; useState only for things we want on-screen.
// ═══════════════════════════════════════════════════════════
import { StatusBar } from 'expo-status-bar';
import Constants from 'expo-constants';
import { useState, useRef } from 'react';
import { StyleSheet, Text, View, Button, ScrollView, TextInput } from 'react-native';
import {
  RTCPeerConnection,
  RTCSessionDescription,
  RTCIceCandidate,
} from '@livekit/react-native-webrtc';

const DEFAULT_URL = Constants.expoConfig?.extra?.signalingUrl ?? 'ws://10.80.180.17:3000';
const STUN_CONFIG = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// Cristian's
const BURST_SIZE          = 10;
const SAMPLE_INTERVAL_MS  = 100;
const BURST_INTERVAL_MS   = 10000;
const BURST_TIMEOUT_MS    = 3000;
// Leader broadcast + ticker
const POSITION_TICK_MS    = 100;
const BROADCAST_INTERVAL_MS = 500;
// Snap / ease
const SNAP_THRESHOLD_MS   = 500;
const EASE_ENTER_MS       = 50;
const EASE_EXIT_MS        = 30;
const EASE_RATE_MAGNITUDE = 0.02;

export default function App() {
  // ─── UI state (periodic updates) ───
  const [url, setUrl]           = useState(DEFAULT_URL);
  const [status, setStatus]     = useState('Not connected');
  const [role, setRole]         = useState('-');
  const [dcState, setDcState]   = useState('-');
  const [log, setLog]           = useState([]);
  const [positionText, setPositionText] = useState(0);
  const [rttText, setRttText]           = useState('-');
  const [offsetText, setOffsetText]     = useState('-');
  const [burstText, setBurstText]       = useState('-');
  const [expectedText, setExpectedText] = useState('-');
  const [driftText, setDriftText]       = useState('-');
  const [rateText, setRateText]         = useState('1.00');
  const [modeText, setModeText]         = useState('—');
  const [rowCount, setRowCount]         = useState(0);

  // ─── Refs for callback-stable state ───
  const wsRef         = useRef(null);
  const pcRef         = useRef(null);
  const dcRef         = useRef(null);
  const roleRef       = useRef(null);
  const scrollRef     = useRef(null);

  // Position model (D14 — checkpoint + rate)
  const checkpointWallRef = useRef(null);
  const checkpointPosRef  = useRef(0);
  const currentRateRef    = useRef(1.0);

  // Cristian's
  const estimatedOffsetRef = useRef(0);
  const hasOffsetRef       = useRef(false);
  const lastBurstRttRef    = useRef(null);
  const burstNumberRef     = useRef(0);
  const currentBurstRef    = useRef(null);

  // Ease state machine (D15 asymmetric hysteresis)
  const easingRef = useRef(false);

  // In-memory drift log (download deferred to a later phase)
  const driftLogRef = useRef([]);

  // Interval handles for cleanup
  const broadcastIntervalRef = useRef(null);
  const burstIntervalRef     = useRef(null);
  const tickerIntervalRef    = useRef(null);

  // ─── Log helper ───
  const appendLog = (msg) => {
    const stamp = new Date().toISOString().slice(11, 23);
    setLog((prev) => [...prev, `[${stamp}] ${msg}`].slice(-300));
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 0);
  };

  // ─── Position model (D14) ───
  const setCheckpoint = (pos, rate) => {
    checkpointWallRef.current = Date.now();
    checkpointPosRef.current  = pos;
    currentRateRef.current    = rate;
  };
  const currentPosition = () => {
    if (checkpointWallRef.current === null) return 0;
    return checkpointPosRef.current + (Date.now() - checkpointWallRef.current) * currentRateRef.current;
  };

  // ─── Reconciliation (D5 + D15) ───
  const applyCorrection = (drift, expected) => {
    if (!hasOffsetRef.current) return 'none';
    const absD = Math.abs(drift);

    if (absD >= SNAP_THRESHOLD_MS) {
      setCheckpoint(expected, 1.0);
      easingRef.current = false;
      appendLog(`SNAP: drift ${drift.toFixed(0)}ms → seek to expected ${expected.toFixed(0)}ms`);
      return 'snap';
    }
    if (easingRef.current) {
      if (absD < EASE_EXIT_MS) {
        setCheckpoint(currentPosition(), 1.0);
        easingRef.current = false;
        appendLog(`EASE exit: drift ${drift.toFixed(0)}ms < ${EASE_EXIT_MS}ms, rate back to 1.00`);
        return 'none';
      }
      const desired = drift > 0 ? 1 - EASE_RATE_MAGNITUDE : 1 + EASE_RATE_MAGNITUDE;
      if (desired !== currentRateRef.current) {
        setCheckpoint(currentPosition(), desired);
      }
      return 'ease';
    }
    if (absD >= EASE_ENTER_MS) {
      const desired = drift > 0 ? 1 - EASE_RATE_MAGNITUDE : 1 + EASE_RATE_MAGNITUDE;
      setCheckpoint(currentPosition(), desired);
      easingRef.current = true;
      appendLog(`EASE enter: drift ${drift.toFixed(0)}ms → rate ${desired}`);
      return 'ease';
    }
    return 'none';
  };

  // ─── Cristian's burst (follower only) ───
  const startBurst = () => {
    burstNumberRef.current += 1;
    const thisBurstId = burstNumberRef.current;
    currentBurstRef.current = { id: thisBurstId, samples: [], startTime: Date.now() };
    appendLog(`Burst #${thisBurstId}: firing ${BURST_SIZE} samples`);
    setBurstText(`#${thisBurstId}: 0/${BURST_SIZE} received`);

    for (let i = 0; i < BURST_SIZE; i++) {
      setTimeout(() => {
        if (dcRef.current?.readyState === 'open' && currentBurstRef.current?.id === thisBurstId) {
          dcRef.current.send(JSON.stringify({
            type: 'ping',
            t1: Date.now(),
            burstId: thisBurstId,
            sampleIndex: i,
          }));
        }
      }, i * SAMPLE_INTERVAL_MS);
    }
    // Timeout safeguard
    setTimeout(() => {
      if (currentBurstRef.current?.id === thisBurstId) {
        appendLog(`Burst #${thisBurstId}: timeout with ${currentBurstRef.current.samples.length}/${BURST_SIZE}`);
        finalizeBurst();
      }
    }, BURST_SIZE * SAMPLE_INTERVAL_MS + BURST_TIMEOUT_MS);
  };

  const finalizeBurst = () => {
    const burst = currentBurstRef.current;
    if (!burst) return;
    const samples = burst.samples;
    if (samples.length === 0) {
      appendLog(`Burst #${burst.id}: NO SAMPLES received`);
      setBurstText(`#${burst.id}: FAILED (0/${BURST_SIZE})`);
      currentBurstRef.current = null;
      return;
    }
    const best = samples.reduce((a, b) => (a.rtt < b.rtt ? a : b));
    const minRtt = Math.min(...samples.map((s) => s.rtt));
    const maxRtt = Math.max(...samples.map((s) => s.rtt));

    setOffsetText(best.offset.toFixed(1));
    setBurstText(`#${burst.id}: ${samples.length}/${BURST_SIZE} RTT [${minRtt},${maxRtt}] ms, best θ ${best.offset.toFixed(1)}`);
    appendLog(`Burst #${burst.id} done: ${samples.length}/${BURST_SIZE}, RTT [${minRtt},${maxRtt}]ms, chose θ ${best.offset.toFixed(1)}ms`);

    estimatedOffsetRef.current = best.offset;
    hasOffsetRef.current = true;
    lastBurstRttRef.current = best.rtt;
    currentBurstRef.current = null;
  };

  // ─── DataChannel setup (both sides) ───
  const setupDataChannel = (dc) => {
    dc.addEventListener('open', () => {
      appendLog('DataChannel OPEN — P2P connection live!');
      setDcState('open');
      setStatus('Connected P2P');

      // Both peers start the position ticker from t=0.
      setCheckpoint(0, 1.0);
      tickerIntervalRef.current = setInterval(() => {
        setPositionText(Math.round(currentPosition()));
      }, POSITION_TICK_MS);
      appendLog('Position ticker started at t=0');

      if (roleRef.current === 'A') {
        appendLog('I am the leader — echoing pings + broadcasting position');
        broadcastIntervalRef.current = setInterval(() => {
          if (dc.readyState === 'open') {
            dc.send(JSON.stringify({
              type: 'leader-position',
              position: currentPosition(),
              leader_clock: Date.now(),
            }));
          }
        }, BROADCAST_INTERVAL_MS);
      } else {
        appendLog(`I am the follower — Cristian's burst sync every ${BURST_INTERVAL_MS / 1000}s`);
        startBurst();
        burstIntervalRef.current = setInterval(() => {
          if (dc.readyState === 'open') startBurst();
        }, BURST_INTERVAL_MS);
      }
    });

    dc.addEventListener('close', () => {
      appendLog('DataChannel CLOSED');
      setDcState('closed');
      [broadcastIntervalRef, burstIntervalRef, tickerIntervalRef].forEach((r) => {
        if (r.current) { clearInterval(r.current); r.current = null; }
      });
    });

    dc.addEventListener('message', (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'ping') {
        // A side: echo with T2, T3
        const t2 = Date.now();
        dc.send(JSON.stringify({
          type: 'pong',
          t1: msg.t1,
          t2,
          t3: Date.now(),
          burstId: msg.burstId,
          sampleIndex: msg.sampleIndex,
        }));
      }
      else if (msg.type === 'pong') {
        // B side: process reply
        const t4 = Date.now();
        const { t1, t2, t3, burstId, sampleIndex } = msg;
        const rtt    = (t4 - t1) - (t3 - t2);
        const offset = ((t2 - t1) + (t3 - t4)) / 2;
        setRttText(String(rtt));

        const burst = currentBurstRef.current;
        if (burst && burstId === burst.id) {
          burst.samples.push({ rtt, offset, sampleIndex });
          setBurstText(`#${burst.id}: ${burst.samples.length}/${BURST_SIZE} received`);
          if (burst.samples.length === BURST_SIZE) finalizeBurst();
        }
      }
      else if (msg.type === 'leader-position') {
        // B side: compute expected, drift, apply correction
        const tReceive = Date.now();
        const leaderPos   = msg.position;
        const leaderClock = msg.leader_clock;
        const leaderClockInB = leaderClock - estimatedOffsetRef.current;
        const deltaT  = tReceive - leaderClockInB;
        const expected = leaderPos + deltaT;
        const local    = currentPosition();
        const drift    = local - expected;

        setExpectedText(expected.toFixed(0));
        setDriftText(drift.toFixed(0));

        const correction = applyCorrection(drift, expected);
        setRateText(currentRateRef.current.toFixed(2));
        setModeText(correction);

        driftLogRef.current.push({
          timestamp_ms: tReceive,
          burst_offset_ms: estimatedOffsetRef.current,
          sample_rtt_ms: lastBurstRttRef.current,
          leader_position_ms: leaderPos,
          expected_position_ms: expected,
          local_position_ms: local,
          drift_ms: drift,
          correction_applied: correction,
          playback_rate: currentRateRef.current,
        });
        setRowCount(driftLogRef.current.length);
      }
      else if (msg.type === 'chat') {
        appendLog(`Peer says: ${msg.text}`);
      }
    });
  };

  // ─── WebRTC PeerConnection ───
  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(STUN_CONFIG);
    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate && wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ice-candidate', candidate: event.candidate }));
      }
    });
    pc.addEventListener('connectionstatechange', () => {
      appendLog(`PeerConnection state: ${pc.connectionState}`);
    });
    pc.addEventListener('datachannel', (event) => {
      dcRef.current = event.channel;
      setupDataChannel(event.channel);
    });
    pcRef.current = pc;
    return pc;
  };

  const startCall = async () => {
    const pc = createPeerConnection();
    const dc = pc.createDataChannel('sync');
    dcRef.current = dc;
    setupDataChannel(dc);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsRef.current?.send(JSON.stringify({ type: 'offer', sdp: offer }));
    appendLog('Sent offer to peer');
  };

  const handleOffer = async (sdp) => {
    const pc = createPeerConnection();
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsRef.current?.send(JSON.stringify({ type: 'answer', sdp: answer }));
    appendLog('Sent answer to peer');
  };

  // ─── Signaling ───
  const connect = () => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      appendLog('Already connected');
      return;
    }
    appendLog(`Opening ${url}`);
    setStatus('Connecting…');
    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus('Connected to signaling');
      appendLog('WebSocket OPEN');
    };
    ws.onmessage = async (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      appendLog(`Signaling: ${msg.type}`);

      switch (msg.type) {
        case 'role':
          roleRef.current = msg.role;
          setRole(msg.role);
          setStatus(`I am peer ${msg.role}`);
          break;
        case 'start':
          setStatus('Starting WebRTC handshake…');
          await startCall();
          break;
        case 'offer':
          setStatus('Received offer, sending answer…');
          await handleOffer(msg.sdp);
          break;
        case 'answer':
          if (pcRef.current) {
            await pcRef.current.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            appendLog('Handshake complete');
          }
          break;
        case 'ice-candidate':
          if (pcRef.current && msg.candidate) {
            try { await pcRef.current.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
            catch (err) { appendLog(`ICE add error: ${err.message}`); }
          }
          break;
        case 'error':
          appendLog(`ERROR: ${msg.message}`);
          setStatus(`Error: ${msg.message}`);
          break;
      }
    };
    ws.onclose = () => { setStatus('Disconnected'); appendLog('WebSocket CLOSED'); };
    ws.onerror = (e) => { appendLog(`WebSocket error: ${e.message || 'unknown'}`); };
  };

  const disconnect = () => {
    try { dcRef.current?.close(); } catch {}
    try { pcRef.current?.close(); } catch {}
    try { wsRef.current?.close(); } catch {}
    dcRef.current = null; pcRef.current = null;
    setDcState('-');
  };

  const sendTest = () => {
    if (dcRef.current?.readyState === 'open') {
      const text = `Hello from ${roleRef.current} at ${new Date().toLocaleTimeString()}`;
      dcRef.current.send(JSON.stringify({ type: 'chat', text }));
      appendLog(`I sent: ${text}`);
    } else appendLog('DataChannel not open');
  };

  // ─── Inject button (follower only) — simulated drift for demo ───
  const INJECT_MS = 2000;
  const injectDrift = () => {
    if (checkpointWallRef.current !== null) {
      setCheckpoint(currentPosition() + INJECT_MS, currentRateRef.current);
      appendLog(`Injected +${INJECT_MS}ms drift`);
    }
  };

  const driftColor =
    driftText === '-' ? '#333' :
    Math.abs(parseInt(driftText, 10)) < 50  ? '#0a0' :
    Math.abs(parseInt(driftText, 10)) < 500 ? '#a80' : '#a00';

  return (
    <View style={styles.container}>
      <Text style={styles.title}>SOP Co-Presence — RN port (Phase 3)</Text>

      <View style={styles.row}>
        <Text style={styles.label}>Server:</Text>
        <TextInput style={styles.input} value={url} onChangeText={setUrl}
                   autoCapitalize="none" autoCorrect={false} />
      </View>

      <View style={styles.row}>
        <Button title="Connect"    onPress={connect} />
        <View style={{ width: 6 }} />
        <Button title="Disconnect" onPress={disconnect} color="#888" />
        <View style={{ width: 6 }} />
        <Button title="Send test"  onPress={sendTest} />
        <View style={{ width: 6 }} />
        <Button title="+2000ms"    onPress={injectDrift} color="#c60" />
      </View>

      <View style={styles.statusBox}>
        <Text style={styles.statusText}>Status: {status}</Text>
        <Text style={styles.statusText}>
          Role: {role}  |  DC: {dcState}  |  RTT: {rttText} ms  |  θ: {offsetText} ms
        </Text>
        <Text style={styles.statusText}>Burst: {burstText}</Text>
      </View>

      <View style={styles.syncPanel}>
        <Text style={styles.statusText}>Local pos: {positionText} ms</Text>
        <Text style={styles.statusText}>
          Expected: {expectedText} ms  |  Drift:{' '}
          <Text style={{ color: driftColor, fontWeight: '600' }}>{driftText} ms</Text>
        </Text>
        <Text style={styles.statusText}>
          Rate: {rateText}×  |  Correction: {modeText}  |  Rows: {rowCount}
        </Text>
      </View>

      <Text style={styles.label}>Log</Text>
      <ScrollView ref={scrollRef} style={styles.logBox}>
        {log.map((line, i) => (<Text key={i} style={styles.logLine}>{line}</Text>))}
      </ScrollView>

      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', paddingTop: 50, paddingHorizontal: 12 },
  title: { fontSize: 16, fontWeight: '600', marginBottom: 8 },
  row: { flexDirection: 'row', alignItems: 'center', marginVertical: 4, flexWrap: 'wrap' },
  label: { fontSize: 12, color: '#555', marginRight: 6, marginTop: 6 },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 4,
           paddingHorizontal: 6, paddingVertical: 4, fontFamily: 'monospace', fontSize: 11 },
  statusBox: { backgroundColor: '#eee', padding: 8, borderRadius: 4, marginTop: 6 },
  syncPanel:  { backgroundColor: '#f4f4f4', padding: 8, borderRadius: 4, marginTop: 4,
                borderLeftWidth: 3, borderLeftColor: '#666' },
  statusText: { fontFamily: 'monospace', fontSize: 11, lineHeight: 15 },
  logBox: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 4,
            padding: 6, marginTop: 4, marginBottom: 12 },
  logLine: { fontFamily: 'monospace', fontSize: 9, color: '#333' },
});
