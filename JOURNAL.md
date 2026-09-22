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