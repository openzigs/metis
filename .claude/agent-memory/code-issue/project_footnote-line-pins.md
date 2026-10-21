---
name: footnote-line-pins
description: Narrowing a module citation to a source file:line (#737 / PR #1305) — when it is possible, how the word-overlap matcher misfires, and fixtures that expose it.
metadata:
  type: project
---

Learned on PR #1305 (#737, #996) and its review cycles, 2026-10-16. Code: `server/src/lib/docs-gen/citation-footnotes.ts`.

- **A module citation can be narrowed to `file:line` only during document assembly.** The source facts text is in memory only then. Anything rebuilt from stored sections (a cancelled or stopped run, `partialDocumentMarkdown`) can cite only at module level: stored evidence holds no source text.
- **A module facts id (`facts:<module>:<rank>`) repeats across sections**, each with its own slice of the facts. Code that keeps only the first source per id loses the Rules section's mined rules. Read every slice.
- **Score only the rule text.** The word-overlap matcher must not count the locator token on the line, and must not pass on one shared number plus one word. Test with off-topic sentences that share the module's vocabulary, not only sentences restating a rule.
- **Use real mined-rule lines in fixtures.** They have the `minedRuleLine` / miner-template shape (`[ts const] … — Constant \`X\` = N`). Invented kinds and free-text summaries hide false pins that come from the shared kind and template vocabulary.

Related: [[citation-shapes]], [[test-falsifiability-traps]].
