---
name: test-falsifiability-traps
description: Shapes of test that stay green with the fix deleted, collected across reviews; for each, the fixture or mutation that exposes it. Links the older single-trap entries.
metadata:
  type: project
---

The common cure: **delete the line that is supposed to matter and watch a test go red.** If
none does, the test is vacuous for that line. Each shape below was a real green-with-the-fix-
removed test.

New (2026-10-16, #1185, #1205, #1206 reviews; checked against `main` at b16dcc30):

- **"After the guard trips, X is not written"** against the fake-GitHub fixtures is often
  vacuous: no fixture item would have changed X anyway. Delete the guard line to check.
- **"X is not retried"** tests used errors that could never be mistaken for the retried case,
  so the exclusion guards (`NEVER_A_DROP` in `docs-gen/holistic-synthesizer.ts`, the
  double-count guard) never ran. Use a fixture that matches both the retry case and the
  exclusion.
- **Replace-the-whole-list writes** (`updateProjectV2Field` iterations or single-select
  options): #1205's `withCycles` fixture had no *completed* iterations, and a payload dropping
  them passed 83/83. Fixtures must hold every kind of existing element; break the payload on
  purpose before trusting it. See [[sync-roadmap-label-check-traps]].
- **Extra tool arguments.** `ToolRegistry.invoke` (`server/src/lib/ai/tool-registry.ts:162`)
  runs the zod `parse`, whose default strips unknown keys, so a test passing a model-injected
  `projectId` does not prove the handler ignores it. Pin the schema shape (or `.strict()`).
- **Hand-built tool registries.** Adding a tool to a built-in persona
  (`server/src/lib/custom-agents/index.ts`) also needs it registered in the tests, or
  `ensureBuiltInAgents` refuses to seed. `server/tests/custom-agents.test.ts` registers the
  boot tools in its `beforeEach` (`registerSearchKnowledgeTool`, `registerRequirementTools`);
  `server/tests/agent-tool-refs-238.test.ts` builds hand-made `registryWith(...)` registries
  (defined around line 82).
- **Key-registry file snapshot.** Adding a key to `server/src/lib/config/key-registry.ts`
  fails the `toMatchFileSnapshot` in
  `server/tests/lib/config/key-registry-parse-semantics.test.ts`, seen only in the full server
  run (#1214). Refresh from `server/` with
  `npx vitest run tests/lib/config/key-registry-parse-semantics.test.ts -u` and check that the
  diff adds only the new key.
- **Runbook greps inside markdown tables always pass.** A table cell needs `\|` for a pipe,
  and an agent copies it raw. Under `grep -E`, `\|` is a literal pipe, so an alternation
  check matches nothing and a "must find nothing" check passes vacuously. (Measured on this
  Mac's grep, ugrep 7.8.4: BRE `a\|foo` alternates, `-E 'a\|foo'` does not.) Put commands in
  fenced blocks outside tables (#1214 review).

Older single-trap entries, folded here (retired from the index 2026-10-16; files unchanged):

- [[conditional-write-guards-need-a-race-test]] — where-unchanged race guards: delete the
  clause, a test must go red (#518).
- [[fallback-test-needs-fixture-where-paths-disagree]] — a fallback that reaches the same
  answer hides a deleted filter (#1129).
- [[speckit-regex-negatives-pass-incidentally]] — test the one-change near-miss (#1083).
- [[react-markdown-skiphtml-needs-textcontent-assert]] — "no `<img>`" passes without
  `skipHtml`; assert on `textContent` (#1086).
- [[before-fixture-pins-only-its-scenario]] — regenerate the "off" fixture on the base and
  mutate each off-path line.

**Added 2026-10-18 (#1235–#1254):**
- `vi.clearAllMocks()` does not drain `mockResolvedValueOnce` queues, and CI's retry hides the leak (a test that passes only on retry). `vi.resetAllMocks()` also wipes `vi.mock` factory implementations; call `mockReset()` on the per-test doubles instead. Run new test files with `--retry=0` and grep the server log for "passed only after a retry" (#1242).
- To find unconsumed once-values, add a temporary `afterEach` that calls each double once and compares with the `beforeEach` default. An early-refusing test whose once-value goes unused should assert `not.toHaveBeenCalled()` instead.
- Route wiring through a shared helper (`promoteAndNote`) can be reverted per route with no test failing when the `it.each` covers only some routes. Mutate each call site, not the helper. A "note only when X" helper needs two checks: swap it out per route (proves each route test) and drop its condition (proves the negative halves) (#1249).
- When one fix's end-to-end test is masked by a second fix, mutate each half of the first fix alone at its own layer (#1254).
