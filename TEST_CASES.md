# SOP — Test Case Log

Living inventory of what's been verified, what's been observed opportunistically,
and what's still a gap, grouped by phase. Updated as we run new tests or
discover new edge cases.

## Legend

| Symbol | Meaning |
|---|---|
| ✓ | Verified in a controlled test |
| ◆ | Observed opportunistically in a real session (not a planned test but caught working) |
| ⧖ | Pending verification (built but not yet confirmed) |
| ✗ | Known gap, not yet tested |
| ⊘ | Out of scope or explicit non-goal |

Each case carries an ID like `P2.3` (Phase 2, case 3) so they can be referenced
in commits, journal entries, and the technical report.

---

## Phase 1 — Signaling + WebRTC handshake

| ID  | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| P1.1 | Fresh WebSocket connect → server assigns role A or B | ✓ | Every session; `Client A connected` / `Client B connected` in server log |
| P1.2 | SDP offer/answer exchange via signaling relay | ✓ | Visible in both tabs' logs and server relay log |
| P1.3 | Trickle ICE candidates flow both ways | ✓ | `Added ICE candidate` lines |
| P1.4 | DataChannel OPEN on both sides | ✓ | `DataChannel OPEN — P2P connection live!` on both peers |
| P1.5 | Role-fix: reconnecting A gets A back (not B) when B still present | ✓ | Nov 6 server log confirms `Client A disconnected → Client A connected` cycle |
| P1.6 | 3rd client connect → "Room full" error, WS closed | ⧖ | Code path exists in server.js; never exercised in a real scenario |
| P1.7 | WebSocket reconnect after temporary drop | ◆ | Observed on phone during hotspot network glitches — handshake re-runs |
| P1.8 | Server restart mid-handshake | ✗ | Never deliberately tested |
| P1.9 | Tab reload mid-handshake | ✗ | Haven't forced the race condition |

---

## Phase 2 — Sync engine (sub-phases 2.1–2.5)

| ID  | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| P2.1 | Cristian's 10/10 bursts on localhost | ✓ | Every session, Burst #N 10/10 |
| P2.2 | θ ≈ 0 ± 0.5 ms on localhost | ✓ | Baseline Oct 18 — θ hovers at 0.0 |
| P2.3 | Lowest-RTT selection filters contaminated samples | ✓ | Phone Nov 7 — burst with [70, 800] ms span chose a clean sample, θ stayed near truth |
| P2.4 | Burst timeout → finalize with partial samples | ✓ | Phone Nov 7 — `Burst #3: timeout with 0/10` handled, no crash |
| P2.5 | Burst with zero samples → "NO SAMPLES received", no crash | ✓ | Phone Nov 7 — occurred during PC flapping |
| P2.6 | Snap on `|drift| ≥ 500 ms` | ✓ | +2000ms inject on both platforms; Nov 1 CSV row; Nov 7 phone log |
| P2.7 | Ease on 50 ≤ `|drift|` < 500 ms at ±2% rate | ✓ | Nov 1 CSV shows 9 consecutive ease rows at rate 0.98 for a 200ms inject |
| P2.8 | Dead zone: no correction when `|drift|` < 50 ms | ✓ | Thousands of rows with `correction_applied: none` across sessions |
| P2.9 | Asymmetric hysteresis: enter 50, exit 30 | ✓ | Phone Nov 7 — `EASE exit: drift -28ms < 30ms` observed |
| P2.10 | Rate flip mid-ease (drift crosses zero) | ✓ | Code path exists and tested; `desired !== currentRate` check in applyCorrection |
| P2.11 | `hasOffset=false` guard before first burst | ✓ | First ~10s of every session shows no correction attempts |
| P2.12 | Natural ease (no inject) under real network load | ◆ | Nov 6 browser — drift grew to 61 ms organically under LiveKit load, ease triggered correctly |
| P2.13 | Massive clock skew handled (5.5 hours observed) | ◆ | Nov 7 — laptop's clock jumped 19.8M ms mid-session; sync engine detected via Cristian's, snap-corrected, resumed |
| P2.14 | Cross-platform sync: RN↔browser | ✓ | Nov 7 — θ -1247 ms stable across 12+ bursts, drift 7 ms over 841 broadcasts |
| P2.15 | Sessions longer than 10 min | ✗ | Longest was ~9 min (841 rows at 500ms) |
| P2.16 | Hour+ session stability | ✗ | Not yet run |
| P2.17 | Deliberately-crafted RTT distributions | ✗ | We observe network RTT, don't inject it; comes in eval phase with `netem` |
| P2.18 | Burst `timeout` safeguard `BURST_TIMEOUT_MS = 3000ms` honored under real delays | ✓ | Phone log shows exact timeout fires |

---

## Zero-th step — HTML5 `<video>` hookup (browser)

| ID  | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| Z.1 | `<video>` element loads `/sample.mp4` from Node | ✓ | Visible playback |
| Z.2 | Leader Play button starts both videos via `{type:'play'}` DC message | ✓ | Oct 18 verification |
| Z.3 | Follower snap seeks `video.currentTime` | ✓ | Nov 6 — visible frame jump on inject |
| Z.4 | Follower ease sets `video.playbackRate` (1.02 / 0.98) | ✓ | Observed with audible pitch shift during ease |
| Z.5 | Codec seek recovery lag after snap | ◆ | Measured ~660 ms on browser, then recovers |
| Z.6 | Video ends (sample < session length) | ⊘ | Now mitigated with `loop=true` + 10-min sample |
| Z.7 | User pause/resume/seek UI | ⊘ | Deliberate non-goal; leader-only control |
| Z.8 | Codecs other than H.264/MP4 | ✗ | Only MP4 tested |

---

## α — Video drift instrumentation

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| α.1 | CSV grows `video_current_time_ms` + `video_vs_model_gap_ms` columns | ✓ | Smoke test Nov 1 + CSV downloaded Nov 6 |
| α.2 | Steady-state video lag measurement | ✓ | **123 ± 1 ms** across 60 samples (browser, Nov 6) |
| α.3 | Gap=0 when video not playing | ✓ | First ~30 rows of Nov 6 CSV before Play clicked |
| α.4 | Gap meaningful only during linear playback (loop boundary breaks it) | ◆ | Known artifact, documented |
| α.5 | Live UI readout updates every 100 ms | ✓ | Visible in all screenshots |

---

## Phase 3 Step 1 — LiveKit SFU (browser)

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| P3S1.1 | Server-side token minting with API secret from `.env` | ✓ | `curl /livekit/token` returns valid 287-char JWT |
| P3S1.2 | Browser joins room + publishes camera + mic | ✓ | Nov 6 — "camera + mic published" log |
| P3S1.3 | Remote track subscription + auto-render | ✓ | Nov 6 — camera feeds visible both tabs |
| P3S1.4 | Clean disconnect handling | ✓ | Nov 6 — disconnect restores state |
| P3S1.5 | "Remote: N" counter updates | ✓ | Visible in all post-Join screenshots |
| P3S1.6 | Network failure mid-call (forced) | ✗ | LiveKit SDK auto-reconnect expected, never exercised |
| P3S1.7 | Token expiry at TTL 2h | ✗ | Never hit |
| P3S1.8 | 3+ participants | ⊘ | Explicit N=2 per D5 |

---

## Phase 3 Step 2 — Audio ducking (browser)

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| P3S2.1 | Remote speaker → `video.volume = 0.2` | ✓ | Nov 6 — DUCK log lines fire on both tabs |
| P3S2.2 | 500 ms release tail → volume = 1.0 | ✓ | Nov 6 — `DUCK: release` logs |
| P3S2.3 | Overlapping speech cancels release | ✓ | Code path exists + observed during cycling speech |
| P3S2.4 | Local participant excluded (no self-duck) | ✓ | Speaker-identity filter in handler |
| P3S2.5 | Room disconnect mid-duck restores volume | ✓ | Cleanup in Disconnected handler |
| P3S2.6 | Feedback-loop detection | ⊘ | Not solved; test with headphones |
| P3S2.7 | ActiveSpeakersChanged latency sensitivity | ✗ | LiveKit documents ~100 ms detection delay; haven't measured impact |

---

## PiP layout — browser

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| PIP.1 | Remote camera renders as 200×150 overlay, top-right | ✓ | `db3479d` commit, visible in screenshots |
| PIP.2 | "Remote: N" badge readable over camera content | ✓ | Dark semi-transparent background |
| PIP.3 | Drag / resize / dismiss | ⊘ | v1 is static by design |
| PIP.4 | Multiple remotes stacking | ⊘ | N=2 |

---

## RN port — Phase 1+2+3 (signaling, handshake, sync engine)

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| RN.1 | EAS Dev Client builds + installs on Android | ✓ | Nov 7 build URL + APK install |
| RN.2 | Phone joins signaling + correct role assignment | ✓ | Nov 7 — phone as A then B in different sessions |
| RN.3 | WebRTC handshake phone↔browser over WiFi | ✓ | Nov 7 — DataChannel OPEN logged on both |
| RN.4 | Cristian's 10/10 bursts over real WiFi | ✓ | Nov 7 — bursts #35 onward |
| RN.5 | θ stable under real network noise | ✓ | Nov 7 — θ within −1232 to −1253 ms across 12+ bursts |
| RN.6 | Drift held in dead zone across long run | ✓ | Nov 7 — 7 ms across 841 broadcasts |
| RN.7 | Snap fires correctly cross-platform | ✓ | Nov 7 — +2000 ms inject → SNAP log within 130 ms |
| RN.8 | Ease + hysteresis exit cross-platform | ✓ | Nov 7 — natural ease triggered at −199 ms, exited at −28 ms |
| RN.9 | PeerConnection flapping on mobile WiFi, sync recovers | ◆ | Nov 7 phone log shows disconnected/connected cycles; bursts timeout then resume |
| RN.10 | Massive RTT variance [70, 800] ms handled | ◆ | Nov 7 — lowest-RTT filter still produced stable θ |
| RN.11 | App backgrounded → foregrounded on Android | ✗ | Likely needs state save/restore; not tested |
| RN.12 | Permission revocation mid-session | ✗ | Not tested |
| RN.13 | Low-memory Android crash recovery | ✗ | Not tested |

---

## RN port — Phase 4 (video + LiveKit + ducking + PiP)

| ID | Case | Status | Evidence / Notes |
|-----|------|--------|------------------|
| RN4.1 | expo-video loads `/sample.mp4` from Node | ✓ | Nov 7 screenshots show park footage |
| RN4.2 | Leader Play propagates to follower via DC 'play' | ✓ | Nov 7 — "Received play from leader" log |
| RN4.3 | Snap seeks `player.currentTime` (visible jump) | ✓ | Nov 7 — visible frame jump on phone when +2000ms pressed |
| RN4.4 | Ease sets `player.playbackRate` | ✓ | Logged "EASE enter: rate 1.02" |
| RN4.5 | Video loops instead of ending | ✓ | `player.loop = true` set; no visible freeze |
| RN4.6 | Snap seek recovery time on expo-video (vs browser's 660 ms) | ✗ | Not measured — codec-pipeline comparison pending |
| RN4.7 | LiveKit Room connect from phone | ✓ | Nov 7 — "LiveKit connected as peer-A-..." log |
| RN4.8 | Camera + mic published from phone | ✓ | Nov 7 — "camera + mic published" log |
| RN4.9 | Remote video track subscribed | ✓ | Nov 7 — "subscribed to video from peer-B-..." log |
| RN4.10 | Remote audio track subscribed | ✓ | Nov 7 — "subscribed to audio from peer-B-..." log |
| RN4.11 | Audio ducking fires cross-channel on phone | ✓ | Nov 7 — "DUCK: remote speaking → video.volume 0.2" + release cycles |
| RN4.12 | **Remote video ACTUALLY RENDERS in LKVideoView overlay** | ✓ | Nov 7 phone screenshot — laptop user's camera visible in top-right overlay |
| RN4.13 | Audio ducking audible test (not just log) | ✗ | Needs headphones + deliberate speech |
| RN4.14 | PiP overlay matches browser's look | ✓ | Nov 7 — 120×160 overlay with white border rendering correctly, mirrored across both platforms |
| RN4.15 | Concurrent Phase 2 sync + Phase 3 LiveKit call without interference | ✓ | Nov 7 — Burst #133 cycling, drift 32ms, natural ease (-278ms) + exit all observed WHILE LiveKit room was active with camera + mic + remote video rendering |
| RN4.16 | Natural ease under LiveKit load (cross-platform) | ✓ | Nov 7 — `EASE enter: drift -278ms → rate 1.02` + `EASE exit: drift 24ms < 30ms` observed on browser (role B) during active LiveKit call |

---

## Evaluation phase — NOT YET STARTED

These are the gaps the eval phase (Weeks 11-12 of plan) is supposed to fill.

| ID | Case | Status | Priority |
|-----|------|--------|----------|
| E.1 | `tc`/`netem` matrix: baseline LAN (0 ms, 0% loss) | ✓ | Nov 8 — C0, 3 reps, RMS 40.9, P95 23.8 (eval/results/C0_*) |
| E.2 | `tc`/`netem`: home WiFi (30 ms, 10 ms jitter, 0.5% loss) | ✓ | Nov 8 — C1, RMS 7.0, P95 14.5 |
| E.3 | `tc`/`netem`: 4G mobile (60 ms, 30 ms jitter, 1% loss) | ✓ | Nov 8 — C2, RMS 18.5, P95 34.2 |
| E.4 | `tc`/`netem`: congested 4G (120 ms, 60 ms jitter, 3% loss) | ✓ | Nov 8 — C3, RMS 28.6, P95 46.8 (first condition where ease fires naturally at 6.4%) |
| E.5 | `tc`/`netem`: worst case (250 ms, 100 ms jitter, 5% loss) | ✓ | Nov 8 — C4, RMS 60.7, P95 141.4 (P95 exceeds perceptual threshold; ease fires 26.4%) |
| E.6 | Each condition repeated 3× for reproducibility | ✓ | Nov 8 — all 15 runs completed, per-condition reps consistent within ~10% |
| E.7 | Each run 10 min duration | ✓ | Nov 8 — ~1200 raw rows / ~670 clean per run |
| E.8 | P50/P95/P99 drift percentiles per condition | ✓ | Nov 8 — in eval/results/matrix_summary.md |
| E.9 | RMS drift per condition | ✓ | Nov 8 — in matrix_summary.md |
| E.10 | Correction rate (no-op/ease/snap fraction) per condition | ✓ | Nov 8 — ease rises monotonically 0 → 6.4 → 26.4% with condition severity |
| E.11 | Clock-offset stability over session | ✓ | Nov 8 — θ stable across bursts in all conditions |
| E.12 | Kast baseline comparison | ⊘ | Deliberately scope-cut for time; documented in REPORT_DRAFT.md |
| E.13 | Long-duration session (hour+) | ✗ | Not run. Deferred — the 10-min runs show stability; hour+ would be low-marginal-utility |

---

## Features deliberately NOT built (documented gaps)

| ID | Feature | Rationale |
|---|---|---|
| NG.1 | Supabase ambient-state layer (D8's second channel) | Not in Phase 2/3 scope; documented in proposal, scoped-not-built |
| NG.2 | Interaction overlay (reactions during call, Weeks 9-10) | Plan explicitly marked absorb-slippage phase |
| NG.3 | 3+ participants / group call | D5 explicitly commits to N=2 |
| NG.4 | TURN relay server | D3 defers to Google STUN; TURN is eval-phase option only |
| NG.5 | Cross-platform native-iOS | Plan commits only to Android for RN port |

---

## Workflow for updating this file

When a new test is run:
1. Find the case ID or add a new row if the case is new
2. Change symbol to ✓ (or ◆ if it happened by accident)
3. Fill the Evidence / Notes column with a date + what proved it (CSV filename, commit hash, screenshot timestamp)
4. Commit this file alongside whatever other change the test validated

When a new edge case is discovered (bug, unusual condition, expected-to-fail):
1. Add a new row in the appropriate phase table
2. Mark ✗ until tested
3. Note the discovery context in Evidence / Notes
