# SOP — Real-Time Co-Presence Framework (Prototype)

Study Oriented Project — BITS Pilani Goa Campus, 2026-27, Semester 1.
Guided by Prof. Anita Bhagirathji Agrawal.

## Overview
A cross-platform two-party co-presence framework: synchronized media playback
alongside a live WebRTC call, resilient to mobile network heterogeneity.

## Companion documents
- **Architectural Decisions Log:** https://claude.ai/code/artifact/dc582664-31b8-402f-bd43-a2cf08225601
- **Theory and Concepts Reference:** https://claude.ai/code/artifact/05939da7-fc20-4e20-bd54-d42385b28ffe

## Current status (Phase 1 complete)
- Node.js signaling server (Express + `ws`)
- Browser-based WebRTC client with full SDP offer/answer + Trickle ICE
- P2P RTCDataChannel established, measured RTT on localhost: 1-2ms

## Next
- Phase 2: Cristian's algorithm for clock offset estimation
- Phase 3: Leader-follower reconciliation with hybrid snap/ease correction
- Evaluation: drift benchmarks under simulated network degradation

## Run locally