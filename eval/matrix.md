# Evaluation matrix

Target: five network conditions × three repeats × ten minutes each.
Shaped on the **loopback (`lo`) interface** so both browser tabs' WebSocket
traffic to `127.0.0.1:3000` gets the shaping. Localhost-only — the LiveKit
media leg goes to the cloud SFU and is unaffected (which is what we want:
isolate the sync protocol's response to network degradation).

## Conditions (matches the proposal's Theory doc §7 table)

| ID | Label           | delay (ms) | jitter (ms) | loss (%) | Rationale |
|----|-----------------|------------|-------------|----------|-----------|
| C0 | Baseline (LAN)  | 0          | 0           | 0        | Reference / sanity |
| C1 | Home WiFi       | 30         | 10          | 0.5      | Typical home environment |
| C2 | 4G mobile       | 60         | 30          | 1        | Typical cellular |
| C3 | Congested 4G    | 120        | 60          | 3        | Peak-hour / lossy cellular |
| C4 | Worst case      | 250        | 100         | 5        | Stress boundary |

## Per-condition commands

```bash
# C0 — baseline
./eval/apply-netem.sh lo 0 0 0

# C1 — home WiFi
./eval/apply-netem.sh lo 30 10 0.5

# C2 — 4G
./eval/apply-netem.sh lo 60 30 1

# C3 — congested 4G
./eval/apply-netem.sh lo 120 60 3

# C4 — worst case
./eval/apply-netem.sh lo 250 100 5

# clear between / after
./eval/clear-netem.sh lo
```

## Measurement protocol (per condition, per repeat)

1. Clear netem (`./eval/clear-netem.sh lo`)
2. Restart signaling server fresh
3. Open two browser tabs (→ A + B via role-fix)
4. Wait for DataChannel OPEN on both
5. Apply condition (`./eval/apply-netem.sh ...`)
6. Click Play on the leader
7. **Run for 10 minutes** (~1200 drift rows at 500ms cadence)
8. Pull `driftLog` from follower tab via JS, save as
   `eval/results/<condition>_rep<N>.csv`
9. Clear netem
10. Close tabs; brief pause before next run

## Analysis output (per condition)

- Drop first 60 rows (initial catch-up noise)
- Compute: RMS drift, |drift| P50 / P95 / P99 / max
- Correction rate: fraction `none / ease / snap`
- θ stability: mean, std, range of `burst_offset_ms` (per-burst, deduplicated)
- Video pipeline lag: mean, P95 of `video_vs_model_gap_ms` for rows with `video_current_time_ms > 0`

## Matrix aggregation

One row per (condition × repeat), plus per-condition mean across repeats.
Final deliverable: a single markdown table matching the proposal's claim
shape — *"under 4G with 1% packet loss, P95 drift stays below Nms"*.

## Known caveats / risks for the eval

- Chrome throttles `setInterval` in background/hidden tabs → spurious snaps.
  Mitigation: keep both tabs foregrounded in the pane, or use a different
  harness.
- Netem on `lo` shapes BOTH directions (A→B and B→A both get delayed).
  This is actually fine for the sync protocol since Cristian's accounts
  for RTT; just worth noting.
- Loss% is uncorrelated per packet; real networks have bursty loss.
  Advanced: `netem loss random 1% 25%` for 25% correlation. Deferred.
- `distribution normal` for jitter — proposal doesn't specify, we pick
  normal for realism. Could run `pareto` variant as sensitivity check
  if time allows.

## Reproducing from scratch

```bash
# 1. One-time sudoer entry (bypasses password for /usr/sbin/tc only)
echo "$USER ALL=(ALL) NOPASSWD: /usr/sbin/tc" | sudo tee /etc/sudoers.d/eval-netem
sudo chmod 0440 /etc/sudoers.d/eval-netem

# 2. Make scripts executable
chmod +x eval/*.sh

# 3. Restart signaling server
node server.js &

# 4. Follow Measurement protocol above for each (condition, repeat) pair
```
