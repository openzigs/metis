---
issue: 1836
section: Added
---

- `pnpm --filter @metis/server eval:req-similarity` measures how well the
  configured embedder tells duplicate requirements from related-but-different
  ones, over 124 committed, labelled requirement pairs, and reports precision,
  recall and F1 per similarity threshold. On the default embedder, related
  requirements score as high as true duplicates (best duplicate precision
  0.50), so the committed thresholds treat a "duplicate" match as a suggestion
  for an analyst to confirm.
