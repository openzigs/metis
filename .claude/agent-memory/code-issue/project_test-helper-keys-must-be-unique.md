---
name: test-helper-keys-must-be-unique
description: A test helper that keys results by a non-unique key (file+callee without line) silently overwrites entries and makes the test unable to fail; helpers must key uniquely and throw on a duplicate.
metadata:
  type: project
---

A test helper that keys results by a non-unique key (file+callee without line) silently overwrites entries and makes the test unable to fail; helpers must key uniquely and throw on a duplicate.

In #1071 (PR #1104) the helper `verdicts()` of `go-type-resolution.test.ts` returned a `Map` keyed `file:callee`. A test named for the type-parameter rule put two calls to `Do` in one file — one on a type parameter, one on a local type — and asserted on the map. The second call overwrote the first, so the rule the test was named for could be deleted with every suite green; the second adversarial panel found it as a surviving mutant that bound a WRONG target. Four tests in that file were reading an overwritten entry (three through `get`, one through `values()`). No production bug was behind them — but nothing would have said so if there had been.

**Why:** a `Map.set` on an existing key is not an error, and a test that passes looks the same whether it asserted the right entry or the last one written. The implementer's own mutation run ("99 of 99") never mutated that rule against that test in a way that showed it.

**How to apply:**

- A helper that collects results into a keyed structure keys them by something UNIQUE (`file:line:callee`) and THROWS when a key repeats (`tests/helpers/go-verdicts.ts`).
- A convenience lookup by a shorter key is allowed only when it refuses an ambiguous one: `get("file:callee")` throws when the file makes that call twice, and names the lines.
- When fixing such a helper, make the ambiguous lookup throw FIRST and run everything: the failures are the list of tests that were reading the wrong entry. Then check assertions over `values()` by hand — they do not throw.
- Count and report them, and say whether a production bug was hiding (here: 4 tests, 0 bugs).
- One call under test per line in fixtures; a comment in the fixture saying which line is which.
