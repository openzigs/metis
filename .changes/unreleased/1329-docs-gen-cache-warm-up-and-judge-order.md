---
issue: 1329
section: Changed
---

- On DeepSeek, a docs-gen section written in parts first sends one warm-up call
  holding only the prompt its parts share (1-token reply), so the parts sent in
  parallel read it from the cache. It costs about 24k uncached input tokens per
  such section (about $0.03 a Miniflux BRD run on deepseek-flash) and shows in
  the usage ledger as a `…-warmup-…` call.
- The faithfulness judge now sends its evidence, retrieved sources first, before
  the claims, so consecutive judge calls can share a cached prefix. On native
  Anthropic, a section's parts also cache their shared retrieved sources.
