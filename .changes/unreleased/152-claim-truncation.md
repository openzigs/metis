---
issue: 152
section: Fixed
---

- Grounding checks on large sections complete: claim extraction splits a long
  section into ~8,000-character passages, with its own cap,
  `DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS` (default 16384).
- A grounding reply cut off at the output cap is no longer re-sent in
  `json_object` mode, and its warning names the cap to raise.
- Indexing failures name a slow host, certificate problem or dropped
  connection again; a connection closed before any response is named as such.
