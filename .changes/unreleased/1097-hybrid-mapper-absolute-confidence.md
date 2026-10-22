---
issue: 1097
section: Changed
---

- Requirement→code links are ranked by meaning and keywords together (the project's symbol
  embeddings), falling back to keywords alone with the run saying which ran. Their confidence is
  now absolute, comparable across requirements, instead of 1.00 for every requirement's best link.
- The Affected code panel lists links with a confidence of 0.15 or more and folds the rest under
  "N weaker matches", which opens to show them.
