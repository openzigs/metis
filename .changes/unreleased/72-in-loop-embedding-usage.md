---
issue: 72
section: Fixed
---

- Every embedder call a test-coverage run makes now reaches the run budget, not just the two in the
  match phase. The indexing pass embeds every test case and every step; the judge embeds each batch
  prompt for its semantic-cache key; the suggestion generator embeds each cluster prompt plus every
  suggestion's text for dedup. On a cloud embedder that was real spend the budget never saw, and
  none of it reached `ai_token_usages` — on a cold corpus the indexing pass was the largest part of
  it. One cost tracker now spans the whole run, and each call is recorded under the embedder that
  ran and the model it reported, priced through the same single source as the rest.
