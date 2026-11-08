---
issue: 2024
section: Added
---

- `eval:governing`: a new held-out set, `governing-02-clinic-records`, built from documents no
  prompt was tuned on. It is a fictional clinic network's patient records and clinical safety
  standard, with 40 obligations and 36 requirements. Two AI labellers (the same model as the
  author, so not independent human judgement) labelled it blind to every arm and prompt. They
  agreed on 31 of the 40 pairs either listed (0.78; Cohen's κ 0.93 over all 1,440 cells, about
  97% of them "does not apply" for both). A third pass settled each disagreement with a
  written reason, and a blind consistency pass per cross-cutting rule (IR-04, TP-04, CM-04 and
  others) added eight pairs the first two missed. No person has reviewed the labels. Seven pairs carry a short BA answer
  ("Yes, we do.", "No."). `--baseline` refuses a held-out set. `governing-01` is now marked as the tuning set. Every report says
  which set it read. The held-out set's manifest records a content hash, which the loader
  checks and which ANNOTATION.md must also record, so a re-hash is a written change, and the rule is to read that set only for a decision, never to tune a prompt against
  it.
