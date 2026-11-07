---
issue: 1965
section: Fixed
---

- Impact analysis on a project with several repositories no longer merges a file that has the
  same path in two of them: each is listed and counted on its own under **Files to edit**, the
  **Blast radius** and the impacted tests, and each file names its repository. The markdown export
  names the repository when an item spans more than one. The blast-radius heading now says how many of its files are also files to edit, and a
  product's repository card no longer shows an empty "Role:" label.
