---
issue: 1273
section: Fixed
---

- A reply that dropped while it was arriving, and that METIS asked for again
  (OpenAI, Azure, the Bedrock gateway and local models), is no longer lost
  from the record. These providers report no tokens for a dropped reply, so
  each one is written to the audit log as uncounted (`ai.usage.unmetered`).
  Covers chat, discussions, sub-agents, analysis, impact analysis and document
  generation.
- When Stop or the idle guard ends an Anthropic answer, the tokens it had
  reported still count toward usage and budgets.
