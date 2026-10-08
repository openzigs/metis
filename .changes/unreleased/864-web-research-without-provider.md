---
issue: 864
section: Fixed
---

- Analysis web research now reports once that no web search provider is
  configured, and adds no findings. It used to add a "No web sources found"
  digest for every evidence need, and the web agent cited unrelated local files
  (once, a test file's licence header) as evidence. To enable web research, set
  `WEB_SEARCH_PROVIDER` and its API key.
