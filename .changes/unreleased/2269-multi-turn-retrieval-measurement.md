---
issue: 2269
section: Changed
---

- When chat keeps the excerpts your last answer cited, it now keeps the ones the answer pointed
  at. That includes an answer that names an excerpt as "`file` (chunk #4)". Before, it kept the
  first excerpts of every file the answer mentioned.
- `pnpm eval:ba-qa --multi-turn` asks 8 multi-turn business-analyst questions, each a follow-up
  to an earlier question in the same chat. `--retrieval last-message` compares the result with
  searching the new message alone. The report shows how many expected sources each mode
  retrieved and how well follow-ups were detected.
