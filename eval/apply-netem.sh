#!/usr/bin/env bash
# Apply a netem condition to a network interface.
#
# Usage:
#   ./apply-netem.sh <iface> <delay_ms> <jitter_ms> <loss_pct>
#
# Example:
#   ./apply-netem.sh lo 60 30 1       # "4G mobile" on loopback
#   ./apply-netem.sh ./clear-netem.sh lo   # clear (via clear-netem.sh)
#
# Requires sudoer entry for /usr/sbin/tc (see eval/README.md).
set -euo pipefail

iface="${1:?missing iface}"
delay_ms="${2:?missing delay_ms}"
jitter_ms="${3:?missing jitter_ms}"
loss_pct="${4:?missing loss_pct}"

# Remove any existing qdisc on this iface (ignore error if none).
sudo /usr/sbin/tc qdisc del dev "$iface" root 2>/dev/null || true

if [ "$delay_ms" = "0" ] && [ "$jitter_ms" = "0" ] && [ "$loss_pct" = "0" ]; then
  echo "cleared $iface (baseline)"
  exit 0
fi

# Build the netem command: delay + jitter with normal distribution,
# plus packet loss. Correlation left at defaults (uncorrelated).
sudo /usr/sbin/tc qdisc add dev "$iface" root netem \
  delay "${delay_ms}ms" "${jitter_ms}ms" distribution normal \
  loss "${loss_pct}%"

echo "applied to $iface: delay=${delay_ms}ms jitter=${jitter_ms}ms loss=${loss_pct}%"
sudo /usr/sbin/tc qdisc show dev "$iface"
