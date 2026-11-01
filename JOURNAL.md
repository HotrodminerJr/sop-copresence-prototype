# SOP Development Journal

## Tue 2026-09-15 — Phase 1 complete
- Built Node.js signaling server with Express + `ws`
- Built browser client with full WebRTC handshake:
  - WebSocket signaling → SDP offer/answer → Trickle ICE → RTCDataChannel
- Two tabs successfully connect P2P, RTT measured at 1-2ms on localhost
- Sent chat messages both directions to verify DataChannel is bidirectional
- Committed to GitHub

Debugging notes:
- (none — worked first try, which is either lucky or the tutorial materials
  were solid)

Next session: implement Cristian's algorithm on top of the DataChannel
to estimate clock offset between the two peers.

## Wed 2026-09-16 — Sub-phase 2.1 complete: Cristian's algorithm

- Extended ping/pong to full 4-timestamp Cristian's exchange
- Peer B (follower) sends pings; peer A (leader) echoes with T2/T3 stamped in
- B computes θ = ((T2 − T1) + (T3 − T4)) / 2 on every reply
- On localhost, offset hovers 0.0 ± 0.5ms — the millisecond-resolution noise floor
- Formula verified correct via localhost sanity check
- D9 recorded: only follower runs Cristian's (leader is passive echo)

## Wed 2026-09-16 — Sub-phase 2.2 complete: burst sampling

- Replaced per-second pings with bursts of 10 samples every 10 seconds
- Each sample tagged with burstId + sampleIndex for correlation
- Lowest-RTT sample per burst chosen as best offset estimate
- Timeout safeguard (3s after burst window) so missing samples don't stall progress
- UI shows: current burst id, samples received, RTT [min, max] range, best offset
- D10 recorded: 10 samples per burst, 100ms apart, every 10s cadence

Debugging notes:
- (fill in if anything broke during testing)

## Wed 2026-09-16 — Sub-phase 2.3 complete: leader-follower position broadcast

- Both peers now maintain a local "playback position" that ticks up 1000ms/sec
- Leader (A) broadcasts its {position, leader_clock} every 500ms over DataChannel
- Follower (B) receives each broadcast and computes:
    T_leader_in_B = leader_clock − θ        (convert A's clock to B's)
    Δt            = T_receive − T_leader_in_B  (one-way network delay)
    expected      = leader_position + Δt
    drift         = local_position − expected
- UI shows local position, expected position, and drift (color-coded)
- Added "Inject +2000ms drift" button on B for demo purposes
- On localhost baseline: drift stays within ±10ms naturally (matches theory)
- D11 recorded: position semantic is a pure ms counter; real video hookup deferred
- D12 recorded: initial offset assumed 0 for broadcasts arriving before first Cristian's burst

## Wed 2026-09-16 — Sub-phase 2.4 complete: CSV drift logging

- Added in-memory drift buffer on B; one row appended per broadcast reception
- CSV columns: timestamp_ms, burst_offset_ms, sample_rtt_ms,
  leader_position_ms, expected_position_ms, local_position_ms,
  drift_ms, correction_applied
- Download button generates timestamped file: sop-drift-<ISO>.csv
  via Blob + object URL + hidden anchor click (standard browser download idiom)
- Clear button empties the buffer between demo scenarios
- Row count visible in the sync panel — visible evidence that logging is live
- D13 recorded: in-memory client-side buffer, no server-side persistence

Next session: sub-phase 2.5 — snap-vs-ease reconciliation.
When drift crosses thresholds (50ms dead-zone, 500ms snap boundary),
apply the correction. correction_applied column in the CSV will finally
carry non-'none' values, and drift will visibly return toward zero
after an injection.

## Sun 2026-10-18 — Sub-phase 2.5 complete: snap/ease reconciliation

- Refactored the position model from a single `positionStartTime` to a
  three-field checkpoint model: `{checkpointWall, checkpointPos, currentRate}`
  with `setCheckpoint(pos, rate)` and `currentPosition()` using
  `checkpointPos + (now - checkpointWall) * currentRate`.
- Added `applyCorrection(drift, expected)` called from the leader-position
  handler on every 500ms broadcast. Returns 'none' | 'ease' | 'snap'.
    - |drift| ≥ 500ms  →  SNAP (checkpoint at expected, rate 1.0)
    - 50ms ≤ |drift| < 500ms  →  EASE (rate 0.98 if ahead, 1.02 if behind)
    - exit ease when |drift| < 30ms (asymmetric hysteresis — D15)
    - no-op if hasOffset is false (don't react before first Cristian's burst)
- CSV schema grew by one column: `playback_rate` (1.000 / 1.020 / 0.980).
  Reasoning: direction belongs with sign-of-drift, magnitude belongs in rate,
  separable concerns plot cleanly in matplotlib.
- UI: added "Rate: 1.00× | Correction: none" readout so the demo shows the
  ease kicking in and out visibly.
- Inject button now uses setCheckpoint instead of mutating positionStartTime.
- D14 recorded: checkpoint+rate position model (Option A). Rationale:
  maps 1:1 to HTML5 <video>.playbackRate / expo-av playbackRate for the
  Week 6 React Native port.
- D15 recorded: asymmetric hysteresis (enter 50ms, exit 30ms).

Verification (localhost, two tabs):
- Baseline: θ hovers 0.0 ± 0.5ms, drift < 2ms, correction stays `none`.
- Inject +2000ms → one `snap` row in CSV, drift returns to ~1ms on next
  broadcast. Rate stays 1.00.
- Inject +200ms  → 9 consecutive `ease` rows at rate 0.98, drift decays
  from 200ms → 20ms over ~9s, then `EASE exit` log line and rate back
  to 1.00. CSV cross-section:
    header: ...correction_applied,playback_rate
    snap:   drift_ms=1999.5, correction_applied=snap, playback_rate=1.000
    ease:   drift_ms=200.5,  correction_applied=ease, playback_rate=0.980

Open issue (minor): the "none" rows that arrive before the first Cristian's
burst completes have an empty `sample_rtt_ms` column. That is pre-existing
behavior (handled by `?? ''`), noted here for the evaluation phase since
pandas will read those as NaN.

Next session: Phase 2 is done. Start Phase 3 — port the sync engine to
React Native (Expo) using react-native-webrtc. Expected to shake out
real differences at `playbackRate` integration time; the checkpoint model
chosen in D14 is specifically there to make that one line.