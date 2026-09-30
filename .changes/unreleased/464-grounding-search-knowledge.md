---
issue: 464
section: Changed
---

- A chat reply in a project chat that found its answer by searching the
  project's knowledge base (the `search-knowledge` tool) is now labelled as
  grounded, live and after a reload. Before, it still said no excerpts were
  retrieved. A search of another project, or one that found nothing, does not
  count.
- The grounding label now says "project lookups" rather than "code lookups"
  ("Grounded in Payments · 1 project lookup"), since a knowledge-base search
  is counted alongside code search.
