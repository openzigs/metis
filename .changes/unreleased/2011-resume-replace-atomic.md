---
issue: 2011
section: Fixed
---

- "Analyze remaining repositories" now replaces a repository's earlier code findings in the same
  database write that saves the new ones. Before, a failure between the two writes could leave the
  repository's findings counted twice until the next resume.
