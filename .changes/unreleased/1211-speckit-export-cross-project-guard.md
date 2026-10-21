---
issue: 1211
section: Security
---

- The Spec Kit tasks-to-issues export now asks before it files issues into a
  repository another project has connected (`REPO_CROSS_PROJECT`), like a batch
  publish and a draft pull request. The other project is named only to someone
  who can open it. The dry run is not stopped: it says the export will ask, and
  so does a draft pull request's dry run.
