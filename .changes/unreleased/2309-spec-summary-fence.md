---
issue: 2309
section: Fixed
---

- A discussion about a Spec Kit feature now summarises its spec correctly when the spec's code
  examples nest one fence inside another, such as a `~~~` line inside a backtick block, or
  three backticks inside four. A code block now ends only on a closing line of its own kind, so
  its contents are no longer read as prose and do not cut the summary short.
