---
name: cosine-floors-are-corpus-scaled
description: A dense-cosine floor calibrated on one corpus does not transfer; sweep a second corpus per embedder, and run paid BA-QA from a worktree with the main .env (#2417).
metadata:
  type: project
---

**Cosine scale depends on the corpus, not only the embedder (#2417).** On Miniflux (BA set) gte's expected excerpts sit at ≥0.56; on the small TypeScript fixture portfolio they go down to 0.431 and the old 0.55 floor emptied 2 of 15 answerable questions. bge-small shows the same split; EmbeddingGemma does not (0.57 to 0.59). Any absolute threshold on a cosine (chat floor, link confidence) needs `pnpm eval:ba-qa --floor-sweep --floor-corpus localization-02-fixture-portfolio` as well as the BA set.

**Each embedder needs its own `eval-data/.materialized`.** A knowledge ingest skips unchanged files by checksum, so switching `EMBED_MODEL` in place leaves chunks under the old model. Move the directory aside and re-materialize. gte or bge: about 10 minutes for the BA set; EmbeddingGemma: about 25 minutes, resumable after a timeout.

**Paid runs from a worktree:** a worktree has no `.env`, so `pnpm eval:ba-qa` runs keyless. Run `npx tsx --env-file-if-exists=<main checkout>/.env scripts/eval-ba-qa.ts …` from `server/`. The `default` arm against `off` on 26 questions costs about $1.72 a pair (Sonnet 5.5).
