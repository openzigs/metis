---
issue: 2063
section: Changed
---

- The user guide now names the model the governing-rules accuracy was measured
  on (Claude Sonnet 5.5 on Anthropic), says accuracy on the OpenAI, Azure
  OpenAI, Bedrock and local providers has not been measured, and states the two
  caveats: precision passed its bar by 0.003 on the mean with one run at 0.58,
  and the labels it was scored against are AI-written and unreviewed. The off
  switch, `GOVERNING_DOCS_ENABLED`, is now documented in `.env.example` and in
  `docs/OPERATIONS.md` §6.9, with the model calls the feature makes.
