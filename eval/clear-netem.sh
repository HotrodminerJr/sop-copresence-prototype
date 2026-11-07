#!/usr/bin/env bash
# Remove any netem/qdisc from the given interface. Idempotent.
set -euo pipefail
iface="${1:?missing iface}"
sudo /usr/sbin/tc qdisc del dev "$iface" root 2>/dev/null || true
echo "cleared $iface"
sudo /usr/sbin/tc qdisc show dev "$iface"
