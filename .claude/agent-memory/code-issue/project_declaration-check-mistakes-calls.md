---
name: declaration-check-mistakes-calls
description: Hand-rolled "is this line a declaration?" checks mistake calls for declarations; use foo(() => {, function h() { return foo(1) }, private X x = foo(3);, void foo(x); as negative tests
metadata:
  type: project
---

Hand-rolled 'is this line a declaration?' checks mistake calls for declarations: `foo(() => {`, `function h() { return foo(1) }`, `private X x = foo(3);`, `void foo(x);` — use all four as negative tests (#1135).

**Why:** on PR #1164 (#1135), `declaresFunction` in `server/src/lib/spec-kit/plan-checks.ts` decides whether a retrieved source excerpt shows a function's body, so a plan's "not visible" claim about it can be flagged. The first version accepted a line when ANY declaration keyword opened it and `name(` appeared anywhere after it, or when the line started with `name(` and ended in `{`. The re-review probe found all four call-only shapes above reading as declarations, and end to end an excerpt `func list() {\n\tWithLimit(10).Run(func() {` flagged an honest plan. The suite had only one call negative (`return q.WithLimit(5)`), which the member-call lookbehind rejected for an incidental reason.

**How to apply:** match one declaration shape per language family, anchored at the line start, with the name as the identifier being DECLARED: first after `func`/`def`/`function`/`fn`/`fun`; after exactly one return type with no `=` before it and no `;` after it (Java/C#); or a method head `name(params) {` / `name(params): T {` whose params hold no parens. Test the four lines above, a callback opener (`useEffect(() => {`), and the end-to-end excerpt as negatives, beside positives for Go (with receiver and generics), Python, JS/TS, Java/C# (`void` return included), Rust and Kotlin. Prove it by running the negatives against the old matcher. Related: [[free-text-classifier-needs-negative-corpus]], [[project_speckit-regex-negatives-pass-incidentally]].

**Folded here (retired from the index 2026-10-21; files unchanged):**

- [[free-text-classifier-needs-negative-corpus]] — Free-text classifier: negative corpus: symptom phrasings + opposite class (#1135)
