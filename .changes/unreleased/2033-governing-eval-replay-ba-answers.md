---
issue: 2033
section: Added
---

- `eval:governing`: arm A4 now replays the BA's short answers. Each short-answer pair's
  business fact is asked and its answer given. The rule is re-judged by the shipped settle
  path, then its finding is produced with the answer. The findings after the answers are
  scored in their own row of the report, against a new per-pair label (`answeredVerdict`),
  so the evidence rule for short answers is now measured. `governing-01` gains seven
  short-answer pairs, one of which is a "No." that meets its rule. `governing-02` gains the
  label on its seven pairs and is re-hashed, with the change recorded in its ANNOTATION.md.
