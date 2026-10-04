---
issue: 776
section: Added
---

- Issue drafts can be edited before a batch publishes them. On the Publish page you can
  change a draft's title, body or labels; an approved draft returns to draft, and
  re-generating keeps the edits.
- A draft can be opened as a GitHub draft pull request, with a dry-run plan first. It
  only ever targets the project's saved publish target, never an analysed repository (a
  removed connector's included) or, on the live run, a fork of one. The live run needs
  `issue.publish` and a vault secret you created.
