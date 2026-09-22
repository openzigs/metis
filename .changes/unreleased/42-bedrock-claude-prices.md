---
issue: 42
section: Fixed
---

- Claude Fable 5 on Amazon Bedrock is priced at Bedrock's Fable price ($11 / $55 per million input /
  output tokens on a `us.` inference profile), not Haiku 4.5's $1 / $5. Every built-in Claude price is
  now checked against the price Anthropic or AWS publishes, which also corrected Bedrock Sonnet 5,
  Sonnet 4.6 and Opus 4.8 (Bedrock bills a regional profile of a Claude 4.5+ model at 1.1x the global
  price) and Claude Haiku 3.5 ($0.80 / $4, not $1 / $5). Usage recorded before this keeps its old cost.
- The usage page's **Projected month** figure now re-prices earlier unpriced usage with `MODEL_PRICES`
  the same way the autopilot cost ceiling does, so the two no longer disagree.
