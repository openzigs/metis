---
name: portfolio-gap-engine-writes-no-token-usages
description: The portfolio gap engine writes no token_usages rows, so a ledger query reads its eval spend as zero; meter it with LedgerCostMeter.
metadata:
  type: project
---

The portfolio gap engine writes no `token_usages` rows (#2561). A `token_usages` query for an eval run over it reads zero spend.

**Why:** the gap engine's model calls do not record usage in the ledger, so the usual "read token_usages for the run" diagnosis silently reports nothing.

**How to apply:** meter portfolio eval spend with `LedgerCostMeter`, and do not cite a `token_usages` total as the cost of a portfolio run.
