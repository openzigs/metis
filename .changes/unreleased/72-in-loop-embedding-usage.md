---
issue: 72
section: Fixed
---

- Every embedder call a test-coverage run makes now reaches the run budget, not just the two in the
  match phase. The judge embeds each batch prompt for its semantic-cache key, and the suggestion
  generator embeds each cluster prompt plus every suggestion's text for dedup; on a cloud embedder
  that was real spend the budget never saw, and none of it reached `ai_token_usages`. Each call is
  recorded under the embedder that ran and the model it reported, and priced through the same single
  source as the rest.
