---
name: model-resolution-three-entry-points
description: Run-path model resolution has three entry points
metadata:
  type: project
---

PR #523's first fix covered start but missed regenerate, which reloads the raw metadata.model, and resume (resumeSkippedRepos).

**Why:** A forced tier or provider fallback applied at start only is wrong on retry paths.

**How to apply:** Whenever run-path model handling changes, cover start, resume and regenerate, each with a non-Claude-provider test.
