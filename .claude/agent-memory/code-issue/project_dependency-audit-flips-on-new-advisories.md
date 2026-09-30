---
name: dependency-audit-flips-on-new-advisories
description: CI Dependency audit fails every PR when an advisory is published
metadata:
  type: project
---

On 2026-09-30 a next critical and five axios Highs landed within 15 minutes; every open PR's audit went red. PR #555 fixed both; its first push broke dependency-audit-1363-advisories.test.mjs, which pins exact override bounds.

**Why:** An author's 'also fails on main' goes stale as soon as the fix lands.

**How to apply:** Fix on one PR, run the WHOLE scripts suite, respect minimumReleaseAge (newest release older than 7 days), then gh pr update-branch each blocked PR; a job re-run reuses the old merge ref.
