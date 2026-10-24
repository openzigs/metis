---
name: project_weak-tested-by-relation-check-every-count
description: adding a weak/heuristic relation to "Tested by" needs every surface that counts links checked, not only the per-test label map
metadata:
  type: project
---

When a weak or heuristic relation is added to 'Tested by', check every surface that turns links into a count (listUntestedRequirements and its panel, the workspace rollup, the chat tool's 'Tested by' text), not only the per-test label map — the type system forces the label records to be exhaustive but nothing forces the aggregate counts to distinguish weak from strict.

**Why:** the label records are keyed by relation, so a new relation does not compile until each one names it. The aggregates only count links, so the compiler has nothing to say about whether a weak link should count the same as a strict one. This is a reviewer's finding (a reviewer has no store of its own), filed verbatim above at the dispatcher's request in the #1069 PR; it was not re-measured there.

**How to apply:** when adding a relation that is a guess (name-inferred, bare-name call resolution, lower confidence), search for every reader of the links, not for the relation type. Check at least the three surfaces named above. For each, decide whether a weak link counts, and either leave it out or report it as its own number. Add a test where a requirement has only a weak link and assert what each count says. Related: `project_go-call-resolver-binds-by-bare-name.md`.

Re-confirmed on #1108 (`entry-point` relation): all three surfaces plus the untested panel's `reason` filter needed changing; each has a mutation-killing test.

## Measuring a Tested-by rule offline; router vs subject (#1108, #955)

- **Replay, no model:** copy `server/dev.db` to scratch; a `.mts` run by `server/node_modules/.bin/tsx` with `DATABASE_URL=file:<copy>` calls `resolveTestedBy(pid, ids, {limit: 50}, deps)` passing every threshold in `deps` (so the config service is never read). Diff per requirement: relation of the FIRST test (strict / weak / entry-point-only / untested), and links keyed `test|subject`. Run 7 and older graphs are pre-#1071 (`code_graphs.extractorVersion` null): Go methods are stored without receiver (`feed.go::ScheduleNextCheck`) and most Go calls come back `inferred-call`, so make strict-link claims on run 8/9.
- **Test fan-in share does not discriminate** (run 9, 1,414 Go functions): `NewHandler` is called by 50% of `api_test.go`, `parseEntryIDsParams` 40%, `rss.Parse` 100%. Raw caller count alone demoted the true `ScheduleNextCheck` tests. What separated them: >= 5 test callers AND most callers' names do not CONTAIN the callee's folded name (containment, so receiver-less legacy names still match). 3 demotes true `SettingsForm.Validate` tests; 6 misses `NewHandler`.
- **A `naming` match is a link through the target too:** demoting only `exercises` left `TestNewHandler…` reading as `naming`, and a whole-file target's sibling `naming` match re-added `TestTruncateStringForTSVectorField`. Apply a link rule to both relations.
- **Whole-file word rule:** one shared title word let every `Feed…` client test "test" "Force IPv4 or IPv6 per feed"; the hub's rule (1 word for titles of <= 2 words, else 2) did not, and lost no true positive on six projects. The adversarial panel then found the old one-token `naming` fallback re-admitting a test the rule had just rejected: when a rule drops a link, check every later branch that can offer the same test. Scoped to `analysis-grounding` rows (a `manual` whole-file row is a person's claim); every rangeless row in dev.db had that source.
- **A callee's own test vs an entry point's own test cannot be told apart by name** (#1435 review): `TestParseFeedRSS` of `ParseFeed` and `TestNewHandlerSupportsBasePathStripping` of `NewHandler` have the same shape. Keeping named tests (to save the former) put all 15 `NewHandler`-only requirements back to strict on Miniflux. What separates them: keep a named test only when the CALLEE's own name shares a non-stop word with the title (`new`/`handler`/`get`/… ignored); measured, it restores run 9's 8 entry-point-only requirements.
- **TS/JS graphs attribute test calls to the module, not the test** (#1435 review): nearly all
  test-file call edges come from the test MODULE symbol (~237k of ~248k in dev.db), so a
  Tested-by rule counting "test callers" or reading test names counts and reads test FILES
  there. A threshold measured on Go needs a TS re-measurement.
- **Word rules did no stemming** (#1435 review): `words()` / `sharesRequirementWords` and the
  #860 hub guard compared raw tokens (`traceability/tested-by.ts`). Probe inflected and paraphrased titles ("Parsing feeds"
  vs `TestParseFeed`) when reviewing a title-overlap rule.
