---
issue: 2038
section: Changed
---

- `eval:governing`: a findings-prompt line about short-answer polarity ("No." can meet a
  rule) was measured on `governing-01` with DeepSeek and dropped. The findings prompt is
  unchanged. The short-answer row did not move: every pair that reached the findings call
  was already right. The three misses are applicability misses, which a findings-prompt
  line cannot reach. The reading is recorded in `governing-01`'s ANNOTATION.md.
