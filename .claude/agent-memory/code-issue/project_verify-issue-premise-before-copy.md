---
name: verify-issue-premise-before-copy
description: Check an issue's claims about where data lives, and whether a test exists, against the code before writing copy or filing work on them.
metadata:
  type: project
---

Issue #410 asked for copy explaining "Runtime secrets vs the Vault" as two stores. But `ConfigService` writes every runtime secret into the vault at global scope (`config-service.ts:29`, `:343`), and `/vault` lists those rows. The first copy followed the premise and was wrong. A follow-up edit then removed the one accurate line ("Vault-backed values"). The instruction-correctness lens caught it (PR #433). Separately, #401 was filed as "no test proves the scoping", but a pipeline test already asserted it.

**Why:** issue text is written from the UI's point of view, and the storage layer often disagrees with it.

**How to apply:** before writing explanatory copy, a docs claim or a "no test covers X" issue, grep the write path and the existing tests, and cite the line. When you change shipped copy, grep `.changes/unreleased/`, `docs/` and the tests for the old string too: #437's changelog fragment kept a withdrawn label.
