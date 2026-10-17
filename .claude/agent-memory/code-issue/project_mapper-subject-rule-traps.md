---
name: mapper-subject-rule-traps
description: Requirement→code link rules (#1063/PR #1227) — blast radius re-adds filtered hits, #943 stopwords strip entity nouns, -es plural over-matches.
metadata:
  type: project
---

Collected from #1063 / PR #1227 and its reviews (2026-10-17).

**Filtering hits does not filter what is shown.** In the analysis affected-code path, a symbol removed from the mapper's hits can come back through `computeProjectImpact`'s blast radius as a caller of a kept hit. Any exclusion on the link side, such as dropping test code, must also be applied to `impact.affectedSymbols` in `affected-code-context.ts`.

**#943 stopwords include entity nouns.** `REQUIREMENT_QUERY_STOPWORDS` includes `entry`, `user`, `setting`, `record`, `option`, `status` and `type`. A rule that looks up table or type names must read the query before denoising, or `entries.*` and `users.*` can never match.

**Plural rules.** Stripping "-es" unconditionally makes common short words match: notes/not, ones/on, news/new. Strip "-es" only after s, x, z, ch or sh, and check the shortened forms against the #943 stopwords (tracked on #1097).

**Measure without spending.** Replay stored requirements through the mapper, comparing links before and after (NR-1 to NR-5 in run 9), and run `eval:reqmap` and `eval:impact-recall`. No model is called.

Related: [[mapper-precision-rules-halve-impact-recall]], [[seeded-mappings-are-symbol-bound]].
