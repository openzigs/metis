---
name: portfolio-phase2-review-lessons
description: Durable findings from the #1608 phase-2 reviews (#1618-#1621) and #1613/#1614 - LLM-output dedupe, partition tests, edge orientation, ?dynamic: tables, body-referenced rows, templateType.
metadata:
  type: project
---

From the reviews of PRs #1640-#1642 and #1644-#1646, 2026-10-31. Follow-ups: #1647, #1648.

- **Dedupe of LLM output (#1613):** the normalisation helpers here tend to strip every
  separator, `.` included, and then substring-match. That silently merges distinct items:
  `200ms` inside `1200ms`, and `1.5s` read as `15s`. Test that boundary, and log what the
  dedupe drops.
- **Partition tests (#1618):** product-edges and product-access tests often seed an
  "unattached" repo that belongs to no product, so dropping a `productId` filter still
  passes. Seed a repo attached to a *different* product (P1-only, declared on P2).
- **Edge orientation (#1619):** detected edges are keyed by their (source, target) ends.
  A heuristic that orients a pair by input order (shared tables, shared types, protobuf)
  becomes an idempotency bug on Postgres unless the repo list is sorted. SQLite's rowid
  order hides this from every test. Every consumer of code-graph table symbols must also
  filter the `?dynamic:` placeholder prefix (`DYNAMIC_PLACEHOLDER_PREFIX`).
- **Readable checks (#1620):** product APIs check access on the row the URL addresses, but
  not on rows referenced in the body (`resourceId`, `contractDocId`) or touched by a
  cascade. Probe write paths that link to, or cascade over, hidden-repo data.
- **Two type enums (#1614):** a template's `templateType` (epic, feature, story, bug, task)
  is not `REQUIREMENT_TYPES` (feature, bug, chore, epic, task). Don't merge the two in docs
  or issues.
- **Stacked PRs in orchestrate:** batches with dependent issues come back stacked on the
  first PR's branch. Merge the base PR *without* `--delete-branch`, `gh pr edit --base main`
  the dependents, rebase them `--onto origin/main <old-base-sha>`, and only then delete
  the base branch.
