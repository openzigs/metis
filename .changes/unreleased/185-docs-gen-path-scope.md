---
issue: 185
section: Added
---

- Documentation generation can be limited to a few repository paths. Pass `pathPrefixes`
  (for example `["packages/domain/src/workout/"]`) when generating, or fill in "Limit to paths" in
  the Generate Documentation dialog, and only code under those paths is read and written up. The
  document's title, a banner under its heading and its provenance all say it is scoped, so it is
  never mistaken for a full-project document. A prefix that matches no code is rejected up front.
  `scripts/local-llm/docs-gen-scoped-run.mjs` starts such a run against a local stack and prints a
  summary when it finishes — a local-model test run in hours instead of a day and more.
