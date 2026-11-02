---
issue: 1643
section: Added
---

- Analysing a product now detects the connections between its repositories (shared event topics,
  shared database tables and API calls) from each repository's existing clone, before it writes
  the product documents, so the documents and the product's connection list show what was found.
  A repository that has no clone keeps the connections stored for it, and running the analysis
  again on unchanged code changes nothing.
