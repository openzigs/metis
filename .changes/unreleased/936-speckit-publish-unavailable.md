---
issue: 936
section: Fixed
---

- Spec Kit's **Publish issues to the saved target** is no longer offered after a dry run when the
  server cannot publish: it stays disabled with the reason, because no GitHub issue client is wired
  yet. The dry run now lists every issue title it would create, the publish confirmation names the
  repository and the issue count, one click sends a command once (a server error is no longer
  retried), and the export's error no longer tells a UI user to "re-run with dryRun: true".
