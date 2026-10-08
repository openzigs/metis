---
name: project_seeded-mappings-are-symbol-bound
description: seed-code-links binds ranged citations to the enclosing symbol (often the whole-file module) — test fixtures must match
metadata:
  type: project
---

`seed-code-links-from-findings` (#768) turns a ranged citation into a `codeSymbolId` mapping carrying the innermost enclosing symbol's span. Every parsed file also has a `module` symbol spanning line 1..EOF (`parsers-tree-sitter.ts`, `parsers.ts`), so a header-only citation binds to that module symbol. PR #897 (#860) shipped a hub exemption keyed on "symbol mapping" and a licence-header guard keyed on "file-only range"; both were inert or wrong on real data because fixtures used file-only rows with no module symbol.

**Why:** fixtures that don't match the writer's persisted shape test a path production never takes.

**How to apply:** in traceability fixes, build fixtures with the module symbol and with `codeSymbolId` mappings exactly as the seeder writes them before trusting a shape-keyed rule.

Also (cycle 3 of #897): hub/fan-in fixtures invented a package layout ("five packages") Miniflux doesn't have; real `NewConfigOptions` fan-in is 3 test dirs, so a ≥5-dir threshold never fired. Validate traceability heuristics against `.playwright-mcp/walkthrough-706-run*/wave-e/tested-by.json` and a miniflux/v2 2.3.3 clone (`grep -rl <Symbol> --include=*_test.go | xargs -n1 dirname | sort -u`) before trusting a fixture-only pass.
