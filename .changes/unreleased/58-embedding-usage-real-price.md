---
issue: 58
section: Fixed
---

- Test-coverage embedding usage is recorded under the embedder that ran and priced at that
  embedder's price: $0 for the built-in local embedders, the published price for Amazon Titan Text
  Embeddings V2 and OpenAI's embedding models, and unpriced for any other cloud model until an
  administrator sets a price (Admin → `MODEL_PRICES`, key `embed:<backend>:<model>`). It was priced
  at Claude Haiku's rate, which could use a run's budget up before any LLM call.
