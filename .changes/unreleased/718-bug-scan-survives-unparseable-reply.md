---
issue: 718
section: Fixed
---

- A bug scan no longer fails as a whole when the model returns one reply that is not valid JSON.
  That symbol is skipped and the scan continues. The scan fails only after five such replies in a
  row. Each scan call now has room for reasoning on models that think by default, such as DeepSeek.
  The scan page shows why a scan failed and how many symbols were skipped. A failed scan keeps its
  symbol and token counts. Scan model calls now count toward the project's usage and budget.
