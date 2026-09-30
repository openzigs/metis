---
issue: 573
section: Fixed
---

- A file uploaded before connector-style names were refused, such as one named
  `connector:repo:…`, is no longer labelled as a repository file where an analysis cites it: in
  finding citations, cross-document evidence and a clarifying question's suggested-answer sources.
- Such an upload also no longer hides a matching code symbol from an analysis's code agent; only
  real repository code counts as already covering a symbol.
