---
name: fallback-test-needs-fixture-where-paths-disagree
description: A "falls back when X is not recorded" test passes with the X filter deleted when the fallback reaches the same answer; build fixtures where the fallback and the unfiltered path disagree.
metadata:
  type: project
---

A test of "when X is not recorded (or is invalid), fall back to Y" only proves the filter on X if Y and the unfiltered path give DIFFERENT answers on its fixture. If they agree, deleting the filter leaves the test green.

**Why:** on PR #1157 (#1129), "ignores recorded ids that are not this run's ticked items" gave `sourceIds: ["NR-99"]` to a requirement whose title restated the ticked item. Without `cleanSourceIds`, the unknown id read as "recorded, ticked"; with it, the word fallback also said "ticked". The re-review deleted `cleanSourceIds` in `server/src/lib/analysis/imported-scope.ts` and every test stayed green. The fix fixture ("Import OPML" with `["NR-99"]`, expect "added") makes the fallback disagree with the unfiltered read.

**How to apply:** for every fallback/filter test, write down what the unfiltered path would return on the fixture and pick inputs where it differs from the fallback's answer; then delete the filter and confirm the test goes red. Related: [[speckit-regex-negatives-pass-incidentally]].
