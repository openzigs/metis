---
name: split-advisory-fixes-deadlock-audit
description: Two HIGH advisories fixed in separate PRs keep each PR's Dependency audit red on the other's advisory; land them together.
metadata:
  type: project
---

On 2026-09-29, GHSA-2gc4-cqfq-p2gv (engine.io) and GHSA-v53p-9fqp-m79j (nodemailer) were published within minutes of each other. Two agents fixed them in #427 and #431. Each PR's `Dependency audit` stayed red on the other package, so neither could merge on a clean check. Meanwhile every other open PR was red too. Merging #427's branch into #431 gave one PR with a green audit (merged as #431; #427 was closed as superseded).

**Why:** the audit scans the whole lockfile, so a PR is green only when every HIGH is fixed.

**How to apply:** when the audit goes red, run the audit script locally first to list every advisory, then fix them all on one branch. Keep a major bump as its own commit and guard test, so it is not hidden inside another fix. Links: [[squash-title-closes-issues]].
