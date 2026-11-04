---
issue: 1763
section: Added
---

- Portfolio gap analysis can give every repository in a product its own share
  of the search hits, so a repo no longer reads "not checked" only because a
  sibling repo took every hit of the product's one shared search. Off by
  default (`PORTFOLIO_GAP_PER_REPO_SEARCH`); the hits per repo and per product
  are configurable (`PORTFOLIO_GAP_HITS_PER_REPO`, default 12, and
  `PORTFOLIO_GAP_HITS_PER_PRODUCT`, default 24). It makes no extra model calls,
  and `implemented` still needs a cited excerpt.
