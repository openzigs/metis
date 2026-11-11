---
issue: 2237
section: Added
---

- `pnpm eval:ba-qa --arm off|on --budget <usd>` measures how chat answers a business analyst's
  questions. The question set is `eval-data/corpus/baqa-01-acme-reader/`: 18 questions over two
  products, the Miniflux server and its Python client, materialized by
  `pnpm eval:materialize baqa-01-acme-reader`. It covers single-product rule questions,
  multi-product questions about a synthetic FRD, and ambiguous and unanswerable asks. It
  reports answer correctness, citation precision (with each cited span checked against its
  text) and recall, abstention, follow-up rate and exact ledger-priced spend, with
  `CHAT_CODE_SEARCH_TOOLS`, `CHAT_FUSED_CODE_RETRIEVAL` and `RAG_RERANK` off or on. Results are
  written to `eval-results/ba-qa/`.
