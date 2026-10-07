---
issue: 903
section: Security
---

- Fixed ten High and Critical advisories published on 2026-10-05 and 2026-10-06 that failed the dependency audit on every PR. `simple-git` moves to 4.0.2 and `@modelcontextprotocol/sdk` to 1.31.0. `proxy-addr`, `seroval`, `sharp` and `source-map-js` are fixed with overrides. No new waiver.
- Repo connector clones and pulls now opt the auth env into simple-git 4's environment guard. Without that opt-in, every authenticated clone would fail.
