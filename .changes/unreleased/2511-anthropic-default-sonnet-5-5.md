---
issue: 2511
section: Fixed
---

- With `AI_PROVIDER=anthropic` and no `ANTHROPIC_MODEL`, METIS now runs Claude Sonnet 5.5
  (`claude-sonnet-5-5`), the production model, instead of silently falling back to Sonnet 4.6. This
  covers chat, the Anthropic provider and docs generation (phase 1, phase 2 and the faithfulness
  judge); all three read one shared default. Set `ANTHROPIC_MODEL` to keep an older model.
