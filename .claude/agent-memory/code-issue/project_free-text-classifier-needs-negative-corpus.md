---
name: free-text-classifier-needs-negative-corpus
description: Regex heuristics over free-text bug or plan wording need a negative-corpus test of symptom phrasings and opposite-class sentences; PR tests usually cover only the motivating case
metadata:
  type: project
---

Regex heuristics over free-text bug/plan wording need a negative-corpus test of symptom phrasings and opposite-class sentences ('isn't saved', 'throws', 'does nothing'); PR tests usually cover only the motivating case (#1135).

**Why:** on PR #1164 (#1135), `isReadPathBug` in `server/src/lib/impact-analysis/change-seeds.ts` decided a bug was read-path when `WRITE_PATH_RE` found no write wording. The suite tested the motivating Miniflux #4386 report and three hand-picked write phrasings that the regex had been written to match. The adversarial panel's over-blocking lens found four ordinary reports — "the status isn't saved", "Entries don't get updated", "Deleting a feed throws an error", "Mark all as read does nothing" — all read as read-path, which drops the writer that needs the fix out of the files to edit. The doc comment even claimed "not saved" was covered. The same PR's not-visible check had the mirror fault: it flagged any function declared in a listed file, including locator-only ones the plan honestly had not seen.

**How to apply:** for any classifier over user or model prose, write one test that loops over a corpus of real-world phrasings of the OTHER class (negations with contractions, "throws", "does nothing", "fails to", imperatives such as "Mark all as read") and asserts each, plus the motivating case verbatim from its fixture as the control. Decide which way an unsure input should fall (here: keep the writers) and say so in the doc comment. Mutate back to the old regex and confirm the corpus test goes red. Related: [[project_speckit-regex-negatives-pass-incidentally]], [[fallback-test-needs-fixture-where-paths-disagree]].
