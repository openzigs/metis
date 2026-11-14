---
issue: 2417
section: Changed
---

- Chat's relevance floor (`CHAT_RETRIEVAL_MIN_SCORE`), when left unset, now depends on the
  embedding model and was measured on a second corpus. Each default is the highest floor that
  leaves no answerable test question without excerpts on either corpus: 0.52 for the default
  embedding model, 0.55 for bge-small and 0.60 for EmbeddingGemma at its full 768 dimensions (the
  last two had no floor before). Any other embedding model still gets no floor. `pnpm eval:ba-qa
  --floor-sweep --floor-corpus <corpus>` sweeps a localization corpus, counts requirements the
  code does not implement apart, and names the embedding width and both margin edges.
