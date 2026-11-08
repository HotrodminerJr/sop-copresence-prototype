# SOP — Real-Time Co-Presence Framework

Study Oriented Project — BITS Pilani Goa Campus, 2026-27, Semester 1.
Student: Rajat Upadhyay (2024A8PS1405G). Guided by Prof. Anita Bhagirathji Agrawal.

## Overview

A cross-platform two-party co-presence framework: frame-accurately synchronized
media playback alongside a concurrent live WebRTC call, resilient to the
heterogeneous network conditions typical of real-world mobile usage.

The sync layer uses Cristian's algorithm over a peer-to-peer RTCDataChannel
and a leader-follower hybrid reconciliation policy (no-op / ease / snap)
guarded by asymmetric hysteresis. The live call rides a LiveKit SFU on an
architecturally independent channel so sync and media never compete for
bandwidth. The browser client was ported to a React Native (Expo) Android
client sharing the same sync engine.

## Headline result

Across a Linux `netem` matrix of five network conditions × three ten-minute
replicates (~10,000 clean drift samples), **P95 drift holds under the 50 ms
perceptual co-watching threshold through congested-4G conditions** (120 ms
delay, 60 ms jitter, 3 % loss) and degrades gracefully at a worst-case
250 / 100 / 5 profile. The snap safety valve was never network-triggered.
Full write-up in [`eval/REPORT_DRAFT.md`](eval/REPORT_DRAFT.md).

| Condition | Delay / Jitter / Loss | P95 drift | Ease activation |
|---|---|---|---|
| C0 baseline | 0 / 0 / 0 % | 23.8 ms | 0 % |
| C1 home WiFi | 30 / 10 / 0.5 % | 14.5 ms | 0 % |
| C2 4G | 60 / 30 / 1 % | 34.2 ms | 0 % |
| C3 congested 4G | 120 / 60 / 3 % | 46.8 ms | 6.4 % |
| C4 worst case | 250 / 100 / 5 % | 141.4 ms | 26.4 % |

## Companion documents

- **Final technical report (draft):** [`eval/REPORT_DRAFT.md`](eval/REPORT_DRAFT.md)
- **Development journal:** [`JOURNAL.md`](JOURNAL.md)
- **Test cases:** [`TEST_CASES.md`](TEST_CASES.md)
- **Architectural Decisions Log:** https://claude.ai/code/artifact/dc582664-31b8-402f-bd43-a2cf08225601
- **Theory and Concepts Reference:** https://claude.ai/code/artifact/05939da7-fc20-4e20-bd54-d42385b28ffe

## Repository layout

```
server.js              Node + Express + ws signaling server, LiveKit token minter
public/                Browser client (sync engine, LiveKit integration, CSV logging)
mobile/                Expo + React Native Android client
eval/
  matrix.md            Evaluation matrix specification
  apply-netem.sh       Install netem qdisc on lo for a condition
  clear-netem.sh       Remove netem qdisc
  results/             Per-run raw CSVs + summary JSONs (15 runs)
  plots/               Drift-over-time plots per condition + matrix summary
  REPORT_DRAFT.md      Final technical report
JOURNAL.md             Session-by-session development log
TEST_CASES.md          Manual test cases (browser + RN)
```

## Run the browser prototype

1. `npm install`
2. Create a `.env` file in the repo root with LiveKit credentials:
   ```
   LIVEKIT_URL=wss://<your-project>.livekit.cloud
   LIVEKIT_API_KEY=<key>
   LIVEKIT_API_SECRET=<secret>
   ```
   The free tier at https://livekit.io is sufficient for development.
3. `node server.js`
4. Open `http://localhost:3000` in two browser tabs. The first tab becomes
   leader (role A), the second follower (role B). Click **Join Call** in each
   to start the LiveKit camera + mic feeds, then **Play** on the shared
   video to start sync.

## Run the React Native client

See [`mobile/AGENTS.md`](mobile/AGENTS.md). Requires an EAS Dev Client APK
built via `eas build --profile development --platform android`. Point the
client at the same signaling server; one browser tab acts as leader, the
phone as follower.

## Reproduce the evaluation matrix

1. Scope-grant `tc` via sudoers (example in [`eval/matrix.md`](eval/matrix.md)).
2. Start the server locally and open two browser tabs on `localhost:3000`.
3. For each condition in `{C0, C1, C2, C3, C4}` and each rep in `{1, 2, 3}`:
   - Apply the condition: `./eval/apply-netem.sh lo <delay> <jitter> <loss>`
   - Click **Play** in the leader tab, wait 10 minutes, extract the
     `driftLog` from the follower tab, save as
     `eval/results/<COND>_rep<N>_raw.csv`.
   - Clear the shaping: `./eval/clear-netem.sh lo`
4. Analysis is a pandas pipeline: dedup on `leader_position_ms`, drop the
   first 60 rows, compute RMS / P50 / P95 / P99 / max / correction
   percentages, write a summary JSON. See `eval/matrix.md` for the exact
   commands used in the Nov 8 run.

## Scope cut (documented, not built)

- **Side-by-side Kast baseline comparison** — the eval reports absolute
  performance against the 50 ms perceptual threshold rather than relative
  improvement.
- **Supabase ambient-state layer** (Decision 6) — architecturally committed
  for presence / reactions, not implemented.
- **Interaction overlay** (reactions, annotations) — problem 4 of the
  proposal's four-problem decomposition.
- **Hour-plus continuous evaluation runs** — longest clean run is 10 min
  per condition.

## License

Academic project. No license declared; please contact the author before
reuse.
