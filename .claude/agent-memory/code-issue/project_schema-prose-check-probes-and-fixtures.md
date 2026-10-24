---
name: schema-prose-check-probes-and-fixtures
description: Adversarial probes for the #1133 schema-claim prose heuristic (config keys, same-line decoys, list forms in both cue directions), the paid-rewrite cost of bumping SCHEMA_GROUNDING_VERSION, and fixture/dev.db tips (#1459, #1469/#1477).
metadata:
  type: project
---

From #1459, #1477 and their reviews (2026-10-23/24). Code:
`server/src/lib/docs-gen/schema-claim-check.ts`.

**Probes that broke each round.**
- A rule inferring "column" from a dotted name that starts with a table name over-matches
  config/YAML/API keys (`users.max_count`, `feeds.refresh_interval`). Test shape-based rules
  against config-key prose.
- The column cue was read from the whole line. Put a decoy (a config key, or a second name) on
  the SAME line as a genuine column word; single-span probes pass while mixed lines still
  false-positive.
- Bounding the cue by "the next code span" broke list predicates ("`a`, `b` and `c` are
  columns"). When cue scope narrows, probe list forms against main and mutate each stated
  bound to confirm a test pins it.
- A cue fix in one direction (column word after a list) left the mirror broken (column word
  before a parenthesised list). Probe both directions, with and without brackets, against
  main's copy side by side.

**Version bumps cost money.** Bumping a section-group version constant
(`SCHEMA_GROUNDING_VERSION`, `holistic-synthesizer.ts`) invalidates reuse via the hashed group
context and causes a paid rewrite on the next regenerate. Say so in the changelog, or prefer a
deterministic post-pass on reused output ([[docs-gen-section-reuse-and-regenerate]]).

**Fixtures and dev.db.**
- `src/lib/docs-gen/__fixtures__/brd-before-1070*.json` hash `factsSourceIds` into
  `outputHash`. Regenerate with `WRITE_BEFORE_1070_FIXTURE=1`, compare structurally, and write
  back only changed values (a raw regen diffed ~4.6k lines for ~140 real changes).
- Every facts id in local `dev.db` is repository-backed (`facts:repo:…`), so upload/archive
  provenance needs synthetic tests.
- Reading many `provenanceManifest` rows from `dev.db` with a projects join took 30+ min.
  Select `json_extract(provenanceManifest,'$.sections')` with `documentId IN (subquery)`.

Related: [[deterministic-gate-over-llm-output-probes]], [[read-live-is-not-read-completely]],
[[reader-brd-traps]].
