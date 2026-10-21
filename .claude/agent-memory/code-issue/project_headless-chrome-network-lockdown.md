---
name: headless-chrome-network-lockdown
description: "The exported page can't reach the network" in headless Chrome (Puppeteer) needs three layers — request interception, a CSP meta, and lockdown launch args — and a real-Chromium probe to prove it; interception alone misses WebSockets and WebRTC (PR #1321, #1017).
metadata:
  type: project
---

A claim that a page rendered in headless Chrome cannot reach the network needs three layers, and each was shown insufficient alone on PR #1321 (#1017, document export):

1. **CDP request interception** (`page.setRequestInterception(true)`) — does NOT see WebSocket handshakes (measured). A test that fakes a `ws://` request through interception proves nothing.
2. **A CSP `<meta>` first in `<head>`** with `connect-src 'none'` — closes WebSockets and fetch, but not WebRTC: STUN over UDP and TURN over TCP still got out (measured), because `connect-src` does not govern them.
3. **Launch args** — a dead `--proxy-server` (`socks5://127.0.0.1:9`), `--proxy-bypass-list=<-loopback>`, and `--webrtc-ip-handling-policy=disable_non_proxied_udp`. The policy flag alone misses TURN over TCP.

All three are in `server/src/lib/docs-gen/exporters.ts`.

**How to apply:** prove the claim in real Chromium, never with fakes: a probe server recording HTTP requests, WebSocket upgrades (an `upgrade` listener), TURN-TCP and STUN-UDP, run against the guarded page AND an unguarded control that must reach it (`server/tests/exporters-real-chromium.integration.test.ts`). A new exporter or a Puppeteer upgrade re-runs that suite.
