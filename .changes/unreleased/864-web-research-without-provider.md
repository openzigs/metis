---
issue: 864
section: Fixed
---

- Analysis web research now reports once that no web search provider is
  configured, and adds no findings. It used to add a "No web sources found"
  digest for every evidence need.
- The web agent no longer cites repository or database files, or unranked
  fallback chunks, as evidence (once, a test file's licence header), whether or
  not a provider is configured. It does not search the web itself; only the
  opt-in web research step does, with `WEB_SEARCH_PROVIDER` and its API key set.
