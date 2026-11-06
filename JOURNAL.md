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

## Sun 2026-10-18 — Zeroth step: HTML5 <video> hookup

- Added a real <video> element to both tabs, muted + paused, preload=auto.
- Leader-only Play button. Click sends {type:'play'} over the DataChannel;
  follower starts its own video on receipt. Both peers' models reset to
  checkpointPos=0 at that moment so they start from the same t=0.
- Follower's applyCorrection() now propagates to the video:
    snap  → video.currentTime = expected/1000; video.playbackRate = 1.0
    ease  → video.playbackRate = currentRate (0.98 or 1.02)
    exit  → video.playbackRate = 1.0
- Inject button also seeks the video forward so model AND video are
  genuinely ahead (otherwise snap would un-sync them).
- Video source: downloaded /sample.mp4 into public/ because the browser
  pane sandbox blocks external MP4 fetches. Gitignored.
- Verified end-to-end on two tabs: snap on +2000ms, ease on +200ms over
  ~9 seconds with video visibly slowing to 0.98×.

Discovered: on the follower, immediately after a snap, video.currentTime
lags its own model by ~660ms while the HTML5 decoder re-seeks. The sync
protocol thinks it is caught up; the user still sees a frozen frame for
half a second. This is exactly the open question flagged in Theory §9
about rate/seek control interactions with the codec, now with a measured
number. Does not invalidate the sync engine — it is a measurement that
belongs at the video layer, so Phase 3 and the eval phase will care.

## Sun 2026-11-01 — Alpha: separate video drift from protocol drift

- CSV grew two columns (now 11 total):
    video_current_time_ms   — follower's video.currentTime * 1000
    video_vs_model_gap_ms   — local_position_ms - video_current_time_ms
      (positive = video is behind model, i.e. codec lagging the sync)
- Added live "Video lag: Xms" UI readout updated every 100ms so the
  codec seek recovery is visible without waiting for the next broadcast.
- Rationale: drift_ms records what the SYNC PROTOCOL achieved; the new
  columns record what the USER actually sees. The eval phase needs both.
- Smoke-tested the serialization (browser-pane WebRTC was flaky this
  session so full E2E deferred); applyCorrection + CSV write produce
  the expected row shape across none/ease/snap.
- Everything from 2.1 through here committed as f7f8e5f on main; first
  commit in this repo since Sep 23.

Next session: Phase 3 proper — RN port + LiveKit integration + PiP +
audio ducking. Highest-risk phase per the implementation plan.

## Fri 2026-11-06 — Phase 3 Step 1+2: LiveKit live call + audio ducking

Started with Path B from the sequencing question: add LiveKit in the
browser first, prove the two-channel architecture, port to RN later.
Rationale: the real engineering risk is "two WebRTC connections on
one device competing for CPU/bandwidth" — a resource question, not a
platform question. Browser proves or disproves it in minutes where
RN takes a native rebuild per change, and react-native-webrtc's API
is explicitly modelled on browser WebRTC so the port is mechanical.

LiveKit infrastructure: picked Cloud over self-hosted for dev.
D7 commits to self-hosted for evaluation-phase comparability, but
for dev the Cloud free tier gets us going in 2 minutes and the
switch to self-hosted later is one URL in the client config. Project
is sop-prototype-p9taetqa.livekit.cloud.

Step 1 (LiveKit integration):
- Added livekit-server-sdk + dotenv; 3 env vars in .env (gitignored)
- /livekit/config returns the public WSS URL only (no secrets)
- /livekit/token mints HS256 JWTs server-side for the requested room
  and identity; API_SECRET never leaves the server
- Added <script src="…livekit-client.umd.js"> to index.html; global
  is LivekitClient. Took a false start on .umd.min.js (v2 doesn't
  ship that bundle) — unpkg returned 404 which showed up as
  "LivekitClient is not defined" at join time. One-line fix.
- Both peers can Join Call independently; each becomes a participant
  in the sop-sync-room room, publishes camera+mic, subscribes to
  remote tracks which get attached to a dedicated container
- Verified Nov 1: "Remote participants: 1" on both, each tab shows
  the OTHER peer's camera feed

Step 2 (audio ducking):
- Hooks LiveKit's RoomEvent.ActiveSpeakersChanged → video.volume
- Ducks to 0.2x when any REMOTE participant is in the speakers list
- 500ms release tail so mid-sentence breaths don't cause volume
  pulsing; overlapping speech during release cancels the release
- Cleanup on room disconnect so volume doesn't get stuck quiet
- Design decisions D16 (ducked level 0.2x) and D17 (asymmetric
  speaker-detection + 500ms release) to be written up — same model
  as D14/D15, drafts to paste into the shared Decisions Log

Server-side fix along the way (caught Nov 1 testing):
- Role was `clients.length === 0 ? 'A' : 'B'`. When A disconnected
  and reconnected with B still present, the new tab also became B.
  Two Bs → leader-position broadcast loop (role-gated to A) never
  fires → CSV logging freezes after the first ~4 seconds. The Oct
  18 session's CSV dropouts had this root cause.
- Fix: assign whichever role is MISSING from clients[], not based
  on count. Verified: reconnecting A gets A back, loop stays alive.

Verification Nov 6 (full cycle):
- Both tabs Role A / B correctly
- DataChannel sync: Bursts 10/10 with RTT [0,3]ms, θ hovers ±0.5ms
- Snap: 4 consecutive +2000ms injects → one SNAP each, drift back
  to ~1ms on next broadcast
- LiveKit: both cameras visible, DUCK: remote speaking / DUCK:
  release cycling on both tabs while the sync layer runs underneath
- No contention between channels — snaps and ducking can happen
  simultaneously without affecting each other

CSV baseline Nov 6 (sop-drift-2026-11-06T14-09-48.csv, 121 rows):
- 31s of sync-alone (no video): drift stable at -2.5 to -2.0 ms,
  deep in the dead zone, no correction triggered
- 30s of sync + video (after Play): drift stable at -2 ms,
  video_vs_model_gap_ms CONSISTENTLY 122-124 ms (range 122.6 to
  123.7 across 60 samples). The HTML5 video pipeline has a stable
  ~123ms rendering delay — a constant, not jitter. Compensatable
  if ever needed but almost certainly below the perceptual
  threshold (30-50ms is the co-watching perception floor and this
  is a CONSTANT offset, not a changing drift).

Committed as 59172ae: Phase 3 Step 1+2 bundle. First commit on
this repo in 5 days; closes the five-week-uncommitted window
that's been open since Sep 23.

Next session: close Phase 3 with the small remaining items —
Picture-in-Picture layout (remote camera overlay on main video
instead of side-by-side) and a 5+ minute stress test with both
channels active to measure concurrent-resource behavior. Then
move to Phase 3 Step 3 — React Native port with Expo +
react-native-webrtc + LiveKit's RN SDK.