---
issue: 1080
section: Added
---

- Claude Sonnet 5.5, Haiku 5.5 and Opus 5.5 are in the model catalog with their 128,000-token
  output limit and published prices. Their usage was costed at an older model's price, about
  ten times too high for Haiku 5.5.
- Claude Haiku 5.5 is priced by prompt length, per model call: a call whose prompt (input and
  cache tokens) is over 100,000 tokens is charged at the higher price. A chat turn with tools,
  a discussion reply or a failed turn is one usage row and costs the sum of its calls.
- A `MODEL_PRICES` entry wins over any built-in price, is one flat price, and now also covers
  the model's dated and Amazon Bedrock ids (an exact entry still wins).
