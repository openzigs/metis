---
issue: 670
section: Changed
---

- Self-hosters: the minimum Node.js version is now 22.22.2 (raised from 22.19.0), because the jsdom 30 test environment the UI suite runs in requires it. Check `node --version` before upgrading a source install; the server container image already builds on the latest Node 22.
