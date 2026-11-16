---
name: single-call-extraction-needs-a-token-cap
description: The source-mode RequirementsExtractor call sets no maxTokens, inherits Anthropic's 16,000 default and fails on every corpus FRD on Sonnet 5.5 (#2530).
metadata:
  type: project
---

The source-mode `RequirementsExtractor` call sets no `maxTokens`, so it inherits the Anthropic provider's 16,000 default and fails on every corpus FRD on Sonnet 5.5 (#2529 implementation, filed as #2530).

**Why:** a whole-document extraction's output grows with the document; a provider default sized for chat truncates it, and the parse then fails the whole call.

**How to apply:** any new single-call whole-document extraction needs an explicit output cap sized for the largest corpus document, or batching. Check `token_usages` for an `outputTokens` equal to the cap (see [[zero-findings-read-token-usages-first]]).
