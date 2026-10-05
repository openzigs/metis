---
issue: 853
section: Fixed
---

- The Spec Kit `/plan` prompt's existing-capability example no longer names a function from the
  walkthrough project, so a plan that finds that function found it through retrieval.
- A plan now cites an existing function by its real `path:startLine-endLine`. A symbol inside a
  retrieved source excerpt keeps its line span in the context instead of only the excerpt's chunk
  number, which plans had been printing as a line.
