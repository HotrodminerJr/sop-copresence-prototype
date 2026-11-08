# SOP — Technical Report Draft

Study Oriented Project, BITS Pilani Goa, 2026-27 Semester 1.
Student: Rajat Upadhyay (2024A8PS1405G). Guide: Prof. Anita Bhagirathji Agrawal.

---

## Abstract

Existing cross-platform tools for remote co-presence force a trade-off between
synchronous communication and synchronous media consumption. Apple SharePlay
unifies both but is Apple-only by design; cross-platform alternatives are
browser-extension-bound (Teleparty, Scener) or trade frame-accurate
synchronization for broad screen sharing (Kast). This project builds and
empirically evaluates a two-party co-presence framework that combines a
dedicated low-latency sync protocol — Cristian's clock synchronization and a
leader-follower hybrid reconciliation policy (no-op / ease / snap) guarded by
asymmetric hysteresis, carried over a peer-to-peer RTCDataChannel — with a
concurrent LiveKit SFU live call on an architecturally independent channel.
Cross-platform correctness was verified on an Android client (React Native +
Expo) against a browser leader. Across a Linux `netem` matrix of five network
conditions × three ten-minute replicates (~10,000 clean drift samples), P95
drift holds under the 50 ms perceptual co-watching threshold through
congested-4G conditions (120 ms delay, 60 ms jitter, 3 % loss) and degrades
gracefully at a worst-case 250 / 100 / 5 profile, with the snap safety valve
never network-triggered. A side-by-side Kast baseline, the Supabase
ambient-state layer, and the interaction overlay are scope-cut and remain
documented commitments.

## 1 — Problem

### 1.1 The gap

Remote co-presence — the experience of being *present with* another person
separated by distance — is served today by two disjoint toolchains.
Synchronous communication tools (voice and video calls, messaging) carry
conversation but not shared experience. Synchronous media tools
(watch-together) carry shared experience but assume a separate communication
channel. Native systems that unify both into a single integrated experience
are rare, platform-locked, or forced to restrict the sharable media.

### 1.2 Prior art

Three classes of existing system illustrate the trade-offs:

- **Apple SharePlay** unifies synchronized media playback with a concurrent
  FaceTime call. Architecturally it is the closest analog to the system built
  here. Operationally it is entirely Apple-only — unavailable on any
  non-Apple client, and the sync protocol is proprietary and undocumented.
- **Teleparty and Scener** mediate watch-together through browser extensions
  tied to specific streaming services (Netflix, Disney+, and a handful
  more). They are cross-platform within the browser but cannot host a native
  mobile experience, and the live call, where provided, is overlaid rather
  than deeply integrated with the media timeline.
- **Kast** provides group screen share with a voice channel. It is
  cross-platform and cross-content, but trades frame-accurate media
  synchronization for broad screen sharing: the shared experience is a
  bitmap-forwarded video of one user's screen rather than two
  synchronously-rendered local playbacks, so quality and server bandwidth
  cost scale with the group size rather than with the media itself.

The gap in the literature and the market is thus: *no existing cross-platform,
native-mobile framework combines frame-accurate two-party media
synchronization with a dedicated concurrent live call and an architecturally
independent ambient-state channel.* The combination — not any one component —
is the contribution of this work.

### 1.3 Problem decomposition

The original proposal decomposed the gap into four engineering problems:

1. **Media synchronization under network heterogeneity** — keeping two
   devices' playback within a perceptually imperceptible drift budget
   across LAN, home WiFi, mobile 4G, and worse.
2. **Concurrent multi-stream resource management** — running a live call
   and shared media on one mobile device without either stream starving
   the other for bandwidth, CPU, or audio prominence.
3. **Low-latency ambient state propagation** — a separate channel for
   lightweight shared state (presence, reactions, cursor-equivalents) that
   does not compete with media bandwidth.
4. **Real-time interaction overlay** — reactions, annotations, cursor
   pointers rendered on top of shared media.

The implementation and evaluation in this report defend problems 1 and 2
with built artifacts and measured behavior. Problems 3 and 4 are
architecturally committed (Decisions 6 and 8) but remain unbuilt and are
scoped out of this deliverable; see §5.2.

This report describes the committed architecture (§2), the implementation
realizing it (§3), the empirical evaluation against a five-condition `netem`
matrix (§4), and the thesis claim the measurements license (§5).

## 2 — Architecture (summary)

At runtime the system runs three cooperating channels between two peers: a
signaling WebSocket for setup, a peer-to-peer RTCDataChannel carrying both
clock-sync traffic and the leader's position broadcasts, and a LiveKit SFU
carrying live camera and microphone. One peer is elected leader on connect;
the leader owns the authoritative `<video>` position and rebroadcasts its
predicted position every 500 ms. The follower reconstructs the leader's wall
clock using Cristian's algorithm over the DataChannel and continuously
compares its own predicted position against the leader's, applying rate
corrections (ease), occasional seeks (snap), or nothing at all depending on
the magnitude of the drift. The live call rides the SFU independently so the
sync layer and the media layer never contend for bandwidth on the same path.

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

### 3.1 System overview

Three transports, each matched to a different traffic profile:

```
    Peer A (leader)          Peer B (follower)
    ┌─────────────┐          ┌─────────────┐
    │  <video>    │          │  <video>    │
    │  cam + mic  │          │  cam + mic  │
    └──────┬──────┘          └──────┬──────┘
           │                        │
           ├── signaling WS ────────┤    session setup, rare
           │     (Node + ws)        │
           │                        │
           ├── P2P DataChannel ─────┤    sync: ~40 B / 500 ms
           │   (Cristian's +        │    direct via Google STUN
           │    position bcast)     │
           │                        │
           └── LiveKit SFU ─────────┘    media: camera + mic
```

The signaling WebSocket (Node + `ws`) carries session setup, role assignment,
and WebRTC offer/answer/ICE — rare, must-not-lose, latency-insensitive. The
peer-to-peer RTCDataChannel carries clock-sync bursts and position broadcasts
— frequent, latency-critical, loss-tolerant (the next broadcast corrects).
LiveKit's SFU carries camera and microphone streams — continuous and
bandwidth-heavy, with its own congestion control. The sync layer therefore
never competes with media for bandwidth: the DataChannel is ~40 bytes per
broadcast and runs P2P-direct rather than through the SFU.

### 3.2 Clock synchronization

Cristian's algorithm runs over the DataChannel. The follower sends a ping with
local wall clock `T1`; the leader replies with its wall clock `T2` at receipt;
the follower stamps `T4` on return. Offset `θ = T2 − (T1 + T4) / 2` under the
assumption that the forward and reverse paths are symmetric, bounded by
`±RTT/2` where `RTT = T4 − T1`. The follower runs 10 such pings as a burst
every 10 seconds and keeps only the `θ` from the minimum-RTT sample (lowest
RTT ⇒ least queuing on either leg ⇒ cleanest symmetry assumption). This `θ`
is the single value the follower uses to translate between wall clocks. The
Theory and Concepts Reference §3 derives the symmetry assumption and justifies
the lowest-RTT filter against mean- and median-based alternatives.

### 3.3 Position model

Rather than sampling `<video>.currentTime` on demand, both peers maintain a
continuous-time position model — the triple `{checkpointWall, checkpointPos,
currentRate}`. Predicted position at any wall clock `t` is
`checkpointPos + (t − checkpointWall) × currentRate`. The HTML5 `<video>`
element is kept in step by setting `.playbackRate` to match `currentRate`, so
playback and model stay coherent. On the React Native side the model maps to
`expo-video`'s `playbackRate` identically. This indirection is load-bearing:
it lets reconciliation modulate rate (ease) and position (snap) through the
same abstraction, and it lets the follower compute its own predicted position
for comparison at any instant rather than only at broadcast-receive moments.

### 3.4 Reconciliation

The leader broadcasts its current `{wall, pos, rate}` triple every 500 ms over
the DataChannel. On receipt the follower:

1. translates the leader's wall to local wall using `θ`,
2. computes the leader's predicted position at that wall,
3. computes its own predicted position at the same wall, and
4. takes `drift = own − leader`.

The three-tier decision:

- **|drift| < 50 ms — no-op.** The dead zone covers steady-state jitter;
  triggering corrections here would oscillate.
- **50 ms ≤ |drift| < 500 ms — ease.** Set `currentRate` to
  `leader.rate × (1 ± 0.02)` for a bounded correction window, then revert.
  Rate ±2 % is below the perceptual pitch-shift floor for human audio, so
  the correction is inaudible.
- **|drift| ≥ 500 ms — snap.** Overwrite the follower's `{checkpointWall,
  checkpointPos}` to the leader's and let `<video>.currentTime` seek. Only
  genuine desync (reconnect, stream restart) should ever reach this.

Asymmetric hysteresis guards the 50 ms boundary: drift must climb above 50 ms
to *enter* ease, but fall below 30 ms to *exit*. Symmetric thresholds would
cause ease to toggle on and off every broadcast whenever drift settles near
50 ms; the 50/30 split guarantees a 20 ms gap between activation and release.
The Theory and Concepts Reference §5 covers the rate-vs-snap trade-off and
the hysteresis derivation.

### 3.5 Live call layer

Camera and microphone travel on LiveKit's SFU (Selective Forwarding Unit)
rather than through the same P2P DataChannel as the sync layer — the
two-channel split in Decision 8. Per-peer JWTs are minted server-side so the
API secret never reaches the client, and the WSS URL is served by
`/livekit/config`. A single room (`sop-sync-room`) scopes the two-party
session. The SFU adds one media hop compared to a P2P call, trading roughly
30 ms of extra latency for independent congestion control, selective
forwarding when a third participant is added in future work, and a published
SDK on both browser and React Native (`@livekit/react-native-webrtc`).

### 3.6 Audio ducking

Call audio competing with the shared video audio is the mobile-first use
case's defining concurrency problem. The implementation hooks LiveKit's
`RoomEvent.ActiveSpeakersChanged`: when a remote participant enters the
speakers list, the shared `<video>.volume` drops to 0.2; when the list
empties, a 500 ms release tail delays the restoration. The delay is
asymmetric on purpose — overlapping speech during a release cancels the
restoration, so mid-sentence pauses don't pulse the video volume up and down.
The 0.2× and 500 ms values are empirical: 0.2× is quiet enough to parse
speech over, loud enough to keep the video audible; 500 ms matches typical
inter-sentence pause length.

### 3.7 Cross-platform port

The Expo + React Native port reuses the sync engine essentially verbatim.
`@livekit/react-native-webrtc` exposes the same primitives
(`RTCPeerConnection`, `RTCDataChannel`, media devices) that the browser code
already calls, so the translation is mechanical — refs replace module
globals, Expo's `Audio.setAudioModeAsync` handles routing, and `expo-video`'s
`playbackRate` replaces `<video>.playbackRate`. The build runs on an EAS Dev
Client APK on Android. Cross-platform correctness was validated on a real
network — Android phone as follower, Chrome on laptop as leader, both on
WiFi, with LiveKit sharing the pipe — holding drift at 7 ms across 841
broadcasts over 9 minutes continuous operation, despite a measured
1.25-second wall-clock skew between the two devices. `θ` was stable within
±20 ms across 12 bursts. This single measurement is Decision 2 in empirical
form: the browser prototype's sync behavior survives the port to a different
runtime, different OS, different physical device, and different clock source.

## 4 — Evaluation

### 4.1 Methodology

**What is measured.** Drift is defined as the follower's own predicted
position minus the leader's predicted position at the same wall clock
instant, computed on receipt of each position broadcast (§3.4 step 4). The
follower logs one CSV row per broadcast with:

- `timestamp_ms` — follower local wall at receipt
- `sample_rtt_ms` — RTT of the most recent Cristian's sample used to compute `θ`
- `leader_position_ms` — the position the leader advertised in this broadcast
- `expected_position_ms` — the leader's position projected to the follower's wall using `θ`
- `local_position_ms` — the follower's own predicted position at the same wall
- `drift_ms = local − expected` — signed drift (negative = follower behind)
- `correction_applied` — one of `none`, `ease`, `snap`
- `playback_rate` — the follower's current `<video>.playbackRate`
- `video_vs_model_gap_ms` — difference between `<video>.currentTime` and the model's predicted position, for HTML5 pipeline-delay accounting

**Network shaping.** Linux `netem` on the loopback interface, two browser tabs
as leader + follower at `localhost:3000`. The sudoer-scoped
`eval/apply-netem.sh` installs a `pfifo_fast` qdisc with the condition's
delay / jitter / loss parameters on `lo` before each run and
`eval/clear-netem.sh` removes it afterwards. Self-to-self loopback traffic
does traverse the `lo` qdisc (verified via `ping 127.0.0.1` and via observed
RTT shift inside Cristian's bursts), so the P2P DataChannel sees the shaped
network even on a single machine.

**Five conditions**, matching the proposal's Theory §7 table:

| ID | Condition | Delay | Jitter | Loss |
|----|-----------|-------|--------|------|
| C0 | Baseline (LAN) | 0 ms | 0 ms | 0 % |
| C1 | Home WiFi | 30 ms | 10 ms | 0.5 % |
| C2 | 4G mobile | 60 ms | 30 ms | 1 % |
| C3 | Congested 4G | 120 ms | 60 ms | 3 % |
| C4 | Worst case | 250 ms | 100 ms | 5 % |

Each condition was run 3 times for 10 minutes each — 15 runs, 150 minutes
total, 19,467 raw broadcasts logged. Per-run CSV and summary JSON saved to
`eval/results/`.

**Two cleanups applied before statistics.** (i) **Deduplication on
`leader_position_ms`.** The leader's broadcast interval occasionally fires
twice per 500 ms cycle due to a stale `setInterval` surviving across
DataChannel reconnects (see §4.4), inflating raw CSV row counts by roughly 2×
without changing the measured drift distribution; duplicates are dropped by
keeping the first row per unique `leader_position_ms`. (ii) **First 60 rows
per run dropped.** The first 30 seconds of each run show an elevated,
monotonically decaying drift as the follower's position model locks on to the
leader (first-contact catch-up, independent of network conditions); these
rows are excluded from the reported statistics. After both cleanups ~10,000
clean drift samples remain across the matrix.

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

**Finding 4 — Cristian's lowest-RTT filter handles jitter correctly.** The
selected-θ RTT (the per-burst minimum that Cristian's picked to compute `θ`)
rose monotonically with condition severity:

| Condition | RTT P50 | RTT P95 | RTT Max |
|---|---|---|---|
| C0 | 1 ms | 2 ms | 2241 ms* |
| C1 | 42 ms | 53 ms | 64 ms |
| C2 | 68 ms | 101 ms | 128 ms |
| C3 | 168 ms | 275 ms | 395 ms |
| C4 | 433 ms | 827 ms | 1635 ms |

*C0 max is a Chrome tab-throttle artifact, not representative.

The Cristian's error bound is `±RTT/2`, so under C4 the theoretical worst-case
`θ` error at P95 is ~413 ms — yet the observed drift P95 is 141 ms, a factor
of ~3 below the bound. The lowest-RTT filter is doing exactly what Decision 4
expected: picking the sample most likely to satisfy the forward/reverse
symmetry assumption, so the realised error sits well inside the worst-case
envelope.

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

### 5.1 What was built and validated

A two-party co-presence framework with three independently-channeled layers
— a P2P RTCDataChannel for sub-perceptual media synchronization, a LiveKit
SFU for the concurrent live call, and a signaling WebSocket for session
setup. The sync layer combines Cristian's algorithm over the DataChannel
with a leader-follower position model and a three-tier reconciliation
policy (no-op / ease / snap) guarded by asymmetric hysteresis. Audio ducking
resolves the call-versus-media volume conflict on a single device. The
system was validated cross-platform on a real Android device as follower
against a browser as leader, and empirically characterized across five
network conditions ranging from LAN to a worst-case profile of 250 ms delay
with 100 ms jitter and 5 % loss.

### 5.2 What was scope-cut

Four items from the original proposal were deliberately deferred, in
descending order of proximity to the thesis claim:

- **Side-by-side Kast baseline.** The proposal called for Kast as a
  comparison target; the evaluation instead reports the proposed system's
  absolute performance against the 50 ms perceptual threshold. A Kast
  baseline remains the single highest-value follow-up measurement.
- **Supabase ambient-state layer and interaction overlay.** Decisions 6 and
  8 architecturally commit the ambient channel, but the Supabase +
  presence-state implementation and the reactions/annotations overlay were
  not built. These correspond to problems 3 and 4 in the thesis's
  four-problem taxonomy; the deliverable defends problem 1 (sync under
  heterogeneity) and problem 2 (concurrent multi-stream resource management)
  but leaves 3 and 4 as documented commitments.
- **Hour-plus continuous runs.** The longest clean run is 10 minutes per
  condition. Behavior under multi-hour sessions — specifically, whether
  `θ` drift over the system-clock skew curve stays within the 50 ms budget
  — remains uncharacterized.
- **Loopback-only shaping.** `netem` on `lo` shapes same-machine sync
  traffic correctly, but the LiveKit media leg still traverses the unshaped
  internet. A production evaluation would additionally shape the physical
  interface or run against a self-hosted LiveKit SFU on the same shaped
  link.

### 5.3 Thesis claim licensed by the evidence

The measurements support the following claim, phrased deliberately against
what was tested:

> *Under network conditions up to and including the congested-4G profile
> (120 ms one-way delay, 60 ms jitter, 3 % loss), a two-party WebRTC-native
> sync protocol built on Cristian's clock sync and leader-follower hybrid
> reconciliation can hold P95 drift under the 50 ms perceptual co-watching
> threshold. At worst-case 4G conditions (250 / 100 / 5) the system
> degrades gracefully — rate correction activation climbs from zero to
> ~26 % of broadcasts, P95 drift degrades to ~140 ms, and the snap safety
> valve remains uninvoked — meaning the protocol never abandons the
> follower for a hard seek even when the perceptual budget is exceeded.*

This is problem 1 of the proposal's four-problem taxonomy in empirical form.
Problem 2 (concurrent multi-stream resource management) is defended by the
observed coexistence of the sync layer and LiveKit media across all
evaluation runs without mutual interference. Problems 3 and 4 remain
architecturally committed but unbuilt; closing them against the same
perceptual-threshold standard is the natural continuation of this work.
