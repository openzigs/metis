---
issue: 2417
section: Changed
---

- Chat's relevance floor (`CHAT_RETRIEVAL_MIN_SCORE`), when left unset, now depends on the
  embedding model and was measured on a second corpus. On a set of small TypeScript services the
  old default of 0.55 hid the only matches for 2 of 15 answerable questions, so chat said the
  sources did not show the answer. The default is now 0.43 for the default embedding model, and
  for bge-small, which had no floor before. EmbeddingGemma at its full 768 dimensions gets 0.57.
  Any other embedding model still gets no floor. `pnpm eval:ba-qa --floor-sweep --floor-corpus
  <corpus>` sweeps a localization corpus, and every sweep report now names the closest expected
  excerpt and the closest off-topic one.
