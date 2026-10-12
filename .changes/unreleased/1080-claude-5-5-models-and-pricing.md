---
issue: 1080
section: Added
---

- Claude Sonnet 5.5, Haiku 5.5 and Opus 5.5 (`claude-sonnet-5-5`, `claude-haiku-5-5`,
  `claude-opus-5-5`) are in the model catalog with their 128,000-token output limit and
  published prices. Until now their usage was costed at an older model's price, about ten
  times too high for Haiku 5.5.
- Claude Haiku 5.5 is priced by prompt length, one model call at a time: a call whose prompt
  (input, cache reads and cache writes) is over 100,000 tokens is charged entirely at the
  higher price. A `MODEL_PRICES` entry still wins over any built-in price and is one flat price.
