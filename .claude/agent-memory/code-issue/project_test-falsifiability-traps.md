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

**Added 2026-10-19 (#1257–#1264):**
- An `adversarial-reviewer` voter can return a well-formed SOUND verdict with fabricated citations after a few tool calls; the tally checks only the citation format. Before tallying, confirm each cited identifier exists at the tip, and re-dispatch the lens if one does not (#1257).
- On a scoped `deleteMany` with `notIn` over a nullable column, mutation-test dropping the `{col: null}` OR-branch. SQL `NULL NOT IN` keeps the null rows, and a test that checks only the kept rows passes either way (#1260: survived 19/19).
- In reader-filtered tests, a "no stale duplicate" assertion made as the restricted user cannot fail, because the filter hides exactly the stale row. Assert cardinality as the admin.
- "Not counted as hidden" is vacuous when run by an admin, or when the fixture sits in a project the member can read. Put the fixture where the member cannot read it, and assert the hidden *count*; the id-list check cannot fail there (#1262).
- When a PR threads a new parameter into a helper that has its own unit tests (`paired` into `itemsGivenTo`), mutation-test the call site too. The helper's tests stay green when the caller stops passing it; this survived 258 tests on #1265.
- A test of a pure default-selection helper (`defaultHubRunId`) doesn't prove the component agrees with it. The hub filtered its own list first and rendered empty with every unit test green (#1267). Require a component render test.
- A "conservative" over-approximation fed into `withoutGivenItems` can remove every option, and then the refusal disappears silently. Probe the case where everything is removed (#1266).
- When removing METIS-generated text from an analyst-editable body, probe whitespace variants, a dropped or doubled `> ` and hard-wrapped text. Run the same inputs through the base, the previous head and the current head (#1266, #1269).
- To test a check keyed on the endpoint (such as DeepSeek), use a model id that another branch would otherwise catch (`claude-sonnet-5-5` on the DeepSeek endpoint) (#1275).
- SQLite route tests that mount a sub-router directly (`requirementLinksRouter`) skip the parent guard (`requireRequirementAccess`), so 404-body and existence-oracle assertions prove nothing about production. Mount the parent guard (#1282).
- To prove a prompt reorder changed no wording, import the base and head modules side by side with tsx. The replay fixtures store only sha256 hashes (#1281).

**From #1305 and #1308 and their reviews (2026-10-21).**
- **One test pinning one fallback can hide a second mutation.** On #1305 a tie test kept the
  module footnote and so masked another branch. Check that each mutation fails a test on its
  own, not only that each test failed before its fix.
- **A boundary fallback can pass for the wrong reason.** A sentence-boundary test went green
  because the cluster regex consumed the separator itself (`( ?)` in `CLUSTER_RE`). Mutate the
  fallback itself, not only the input.
- **"Guard runs before X" tests usually check only "no writes, no claims".** Moving the guard
  after the side effect stays green (Spec Kit / publish guard moved after
  `bindPublishCredential`). Mutate the guard's position as well as its presence, and assert the
  side effect itself did not happen; see [[secret-binding-fire-time-checks]].

**From #1344, #1350 and #1353 and their reviews (2026-10-21).**
- **A test named for a precondition must create it.** A huge cap removed the section budget,
  so the hold the test was named for never ran (#1353 review). Assert the precondition held.
- **Equal-size fixtures cannot tell "stop at the first misfit" from "skip and continue".** A
  selector described as "most important first while they fit" must `break` at the first
  topic that does not fit (a priority prefix); test it with unequal-size items (#1353 review;
  detail in [[brd-plan-tests-and-docs-gen-offline-replay]]).
- **A structural "guarded" verdict needs a behavioural twin.** The project-access detectors
  cannot see a plain `r.use(handler)` layer; see [[project-access-guard-wiring]] (#1344).
- **A sanitiser needs an idempotence test:** scrub twice, the second pass changes nothing.
  It caught two fence re-formations on #1350; see [[fence-scrub-unicode-traps]].

**From #930 (2026-10-21).**
- **A race barrier must hold racers AFTER their first statement returns, not before it runs.**
  Releasing gated calls together let a check-then-act mutation pass on Postgres: the pg pool
  opens a second connection lazily, so one racer read and wrote before the other's read ran.
  Same barrier failed the mutation on SQLite. See `server/tests/helpers/approval-review-race-suite.ts`.
- **Assert the barrier filled.** A barrier with a fallback timer that opens it early forced no
  interleave; fail the test unless every racer arrived before it opened (#1359 review).

**From #1409 and #1410 reviews (2026-10-22).**
- **"Parity with before #N" tests drift when the reference is live.** `runAsBefore1063`
  (`server/tests/affected-code-context.test.ts`) built its "byte-identical to before #1063"
  reference from the live `Bm25CodeSymbolSearcher`, which changed scale after #1097. A test
  that reuses today's searcher or mapper is differential, not frozen. Build the reference
  from a frozen stand-in of the old behaviour, or pin literal golden values.
- **"The page has no test file" was false** (#1409 review):
  `ui/tests/analysis/analysis-subviews.test.tsx` renders the real analysis `page.tsx`.
  Before accepting "untestable wiring", grep `ui/tests` for the page's test ids and mutate
  the call site.
