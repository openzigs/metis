---
issue: 178
section: Added
---

- Batched documentation sections run several batches at a time on cloud
  providers (`DOCS_GEN_PHASE2_CONCURRENCY`; unset: 1 on local-gemma, 4 on
  Bedrock, Anthropic, OpenAI and Azure; 1 for any other provider). Replies
  are merged in plan order, so the section text matches a one-at-a-time run
  unless its re-split allowance runs out.
- Each generation logs an estimated cost from its recorded token counts and
  configured prices (cache reads and writes included); unpriced, self-hosted
  and zero-priced models are named and left out.
- The progress bar no longer moves backwards when a cut-off batch is split.
