---
issue: 1329
section: Changed
---

- Docs-gen sections written in parts now put the retrieved repository excerpts
  ahead of each part's own module facts. Every part of a section is given the
  same excerpts, so DeepSeek's automatic prompt cache can read them back
  instead of billing them again. On the Miniflux BRD, a part that followed
  another read about 25,700 cached tokens instead of about 4,000. The share of
  docs-gen input read from the cache rose from 7.5–8.5% to 13.1%.
- Upgrade cost: a stored section that was given retrieved sources is written
  again once, on its next regeneration, because its prompt changed. Sections
  with no retrieved sources are reused as before.
