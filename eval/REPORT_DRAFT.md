# SOP — Technical Report Draft

Study Oriented Project, BITS Pilani Goa, 2026-27 Semester 1.
Student: Rajat Upadhyay (2024A8PS1405G). Guide: Prof. Anita Bhagirathji Agrawal.

---

## 1 — Problem

Existing tools for staying connected across distance split into two disconnected
categories: synchronous communication (calls, chat) and synchronous media
consumption (watch-together). Few systems unify both — a live call alongside
frame-accurately synchronized media, resilient to the heterogeneous network
conditions typical of real-world mobile usage. Apple SharePlay is the closest
architectural analog but is Apple-only by design. Every cross-platform
alternative drops either the native-mobile requirement (Teleparty, Scener are
browser-extension-bound) or trades synchronization precision for broad screen
sharing (Kast).

This project built and empirically evaluated a two-party co-presence framework
that unifies a dedicated low-latency sync protocol with a concurrent live call,
validated cross-platform on an Android client and a browser peer.

## 2 — Architecture (summary)

Full details and decision rationale are in the Architectural Decisions Log and
Theory and Concepts Reference. The eight committed architectural decisions:

1. Signaling transport: Node.js + Express + `ws` over WebSocket
2. Prototype platform: browser tabs, then ported to React Native (Expo)
3. STUN server: Google public (`stun.l.google.com:19302`)
4. Clock synchronization: **Cristian's algorithm over the RTCDataChannel**
5. Reconciliation strategy: **leader-follower with hybrid snap/ease + asymmetric hysteresis**
6. Backend / ambient state: Supabase + Redis (scope-cut, not built — documented commitment)
7. Media SDK: **LiveKit (open-source self-hostable SFU)**
8. Two-channel transport: P2P DataChannel (sync) + SFU (live media)

Additional implementation decisions:
- D14 — position model: `{checkpointWall, checkpointPos, currentRate}` tuple, maps 1:1 to HTML5 `<video>.playbackRate` and `expo-av` playbackRate for the cross-platform port
- D15 — hysteresis: enter ease at 50 ms drift, exit at 30 ms

## 3 — Implementation

Phase 1 (signaling + WebRTC handshake): Node.js server + browser client.

Phase 2 (sync engine): Cristian's with 10-sample bursts every 10 s and lowest-RTT
selection; leader-follower position broadcast every 500 ms; hybrid reconciliation
with the three-tier decision (no-op < 50 ms, ease at ±2 % rate for 50–500 ms,
snap for ≥ 500 ms) and 50/30 asymmetric hysteresis on the ease threshold.

Phase 3 Step 1 (live call integration): LiveKit Cloud SFU joined by both peers
via server-minted JWT tokens; camera + mic published; remote tracks auto-rendered.

Phase 3 Step 2 (audio ducking): LiveKit's `ActiveSpeakersChanged` event hooked to
the shared video's `.volume`, with 0.2× ducked level and 500 ms release tail to
prevent pulsing on mid-sentence pauses.

Phase 3 Step 3 (React Native port): Expo scaffold + `@livekit/react-native-webrtc`
(their fork, exposes identical API) + EAS Dev Client built for Android. Direct
translation of the sync engine using RN hooks. Verified cross-platform on real
WiFi: Android phone as follower, Chrome browser on laptop as leader, 9 minutes
continuous operation with drift held at 7 ms across 841 broadcasts despite a
real 1.25-second wall-clock skew between the devices.

## 4 — Evaluation

### 4.1 Methodology

Linux `netem` on the loopback interface, two browser tabs as leader + follower
at `localhost:3000`. Five conditions matching the proposal's Theory §7 table:

| ID | Condition | Delay | Jitter | Loss |
|----|-----------|-------|--------|------|
| C0 | Baseline (LAN) | 0 ms | 0 ms | 0 % |
| C1 | Home WiFi | 30 ms | 10 ms | 0.5 % |
| C2 | 4G mobile | 60 ms | 30 ms | 1 % |
| C3 | Congested 4G | 120 ms | 60 ms | 3 % |
| C4 | Worst case | 250 ms | 100 ms | 5 % |

Each condition run 3 times for 10 minutes each (15 runs, 150 minutes total,
~10,000 clean drift samples after deduplication + catch-up drop). Per-run CSV
and summary JSON saved to `eval/results/`.

### 4.2 Results — aggregate (mean of 3 reps per condition)

| Condition | Clean n | RMS | P50 |drift| | **P95 |drift|** | P99 |drift| | Max |drift| | ease % | snap % |
|---|---|---|---|---|---|---|---|---|
| C0 baseline (0/0/0) | 1,995 | 40.9 | 23.3 | 23.8 | 34.8 | 854.5 | 0.0 | 0.11* |
| C1 home WiFi (30/10/0.5) | 2,069 | 7.0 | 4.8 | **14.5** | 17.3 | 20.0 | 0.0 | 0 |
| C2 4G (60/30/1) | 1,988 | 18.5 | 15.3 | **34.2** | 41.7 | 43.0 | 0.0 | 0 |
| C3 congested 4G (120/60/3) | 1,997 | 28.6 | 22.0 | **46.8** | 79.1 | 127.2 | 6.4 | 0 |
| C4 worst case (250/100/5) | 2,104 | 60.7 | 25.9 | **141.4** | 217.9 | 311.5 | 26.4 | 0 |

*The single snap in C0 was a Chrome tab-throttling artifact (verifiable
timestamp gap in the drift log), not network-induced.

### 4.3 Headline findings

**Finding 1 — P95 drift stays under the 50 ms perceptual threshold for
co-watching through congested-4G conditions.** For C0, C1, C2, and C3, measured
P95 drift is below the ~50 ms threshold where co-watching users begin to notice
desynchronization. Only at the worst-case condition (C4) does P95 escape to
141 ms.

**Finding 2 — The ease mechanism activates reproducibly and gracefully.**
Correction activation rises monotonically with condition severity:

- C0, C1, C2: 0 % ease (natural dead zone)
- C3: 6.4 % ease (first condition where drift occasionally crosses the 50 ms
  enter threshold)
- C4: 26.4 % ease (one in four broadcasts invokes rate correction)

This is the expected graceful-degradation pattern — pure dead-zone behavior
until the network degrades enough that drift grows, then active rate
modulation keeps it bounded.

**Finding 3 — Snap never fires during network operation.** Across ~10,000
broadcasts under all four `netem` conditions, drift never exceeded the 500 ms
snap boundary. The snap mechanism acts as a true safety valve rather than a
routine correction path. The one snap event observed in the entire matrix
(C0 rep 3) had a measurable timestamp discontinuity of ~3 seconds in the drift
log, consistent with Chrome's background-tab `setInterval` throttling, not
with network-induced drift.

**Finding 4 — Cristian's lowest-RTT filter handles jitter correctly.** Despite
per-burst RTT ranges spanning 50-800 ms under severe conditions, Cristian's
chose consistent θ estimates, confirming the filter design from Decision 4.

**Finding 5 — Cross-platform validation** (preceding the eval phase). Earlier
tests on the Android phone (as follower) ↔ browser (as leader) over real WiFi
held drift at 7 ms across 841 broadcasts despite a real 1.25-second wall-clock
skew between devices. This validates the Decision 2 commitment that the
browser prototype ports cleanly to native mobile.

### 4.4 Limitations and caveats

- **No Kast baseline.** The proposal called for a side-by-side comparison
  against Kast as a baseline. This was scope-cut for time; the eval therefore
  reports absolute performance of the proposed system rather than relative
  improvement. Future work.
- **Duplicate-broadcast bug.** The leader's position broadcast interval fired
  roughly 2× per cycle in these tests (raw row count was ~2× the deduped
  count), likely a stale `setInterval` surviving across DataChannel reconnect.
  Handled by deduplication on `leader_position_ms` in analysis; does not
  change the measured drift behavior but inflates CSV size. Fix scheduled
  post-report.
- **Shaping confined to loopback.** `netem` on `lo` shapes same-machine
  two-tab traffic correctly (verified via ping and via observed RTT change
  in Cristian's bursts), but the LiveKit media leg still traverses the
  internet to the LiveKit SFU and is unshaped. The reported numbers
  therefore isolate the sync protocol's response to network degradation
  independent of the media path. A production evaluation would additionally
  shape traffic on the physical interface or run against a self-hosted
  LiveKit server on the same shaped link.
- **Chrome background-tab throttling** introduces occasional drift artifacts
  unrelated to network conditions (visible as the single C0 snap). For
  statistical hygiene we drop the first 60 rows per run; the throttle
  artifact is rarer and treated as a measured edge case.
- **Supabase ambient-state layer and interaction-overlay phase** scoped out
  per the proposal's "weeks 9-10 absorb-slippage" note. These remain
  documented commitments, not demonstrated features.

## 5 — Summary

The implemented system holds P95 drift under the 50 ms human-perceptual
co-watching threshold across all tested conditions up to and including
congested 4G (120 ms delay, 60 ms jitter, 3 % loss). It degrades gracefully
under worst-case conditions, shifting from zero to 26 % active rate correction
while the snap safety valve remains uninvoked. Combined with the earlier
cross-platform validation on a real Android device over WiFi, this constitutes
empirical support for the proposal's problem-1 thesis: *media synchronization
under network heterogeneity is achievable within perceptual bounds using
Cristian's clock sync + leader-follower hybrid reconciliation over a P2P
WebRTC DataChannel.*
