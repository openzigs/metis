---
issue: 2511
section: Fixed
---

- With `AI_PROVIDER=anthropic` and no `ANTHROPIC_MODEL`, METIS now runs Claude Sonnet 5.5
  (`claude-sonnet-5-5`), the production model, instead of silently falling back to Sonnet 4.6. Set
  `ANTHROPIC_MODEL` to keep an older model.
