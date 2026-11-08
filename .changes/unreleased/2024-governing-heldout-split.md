---
issue: 2024
section: Added
---

- `eval:governing`: a new held-out set, `governing-02-clinic-records`, built from documents no
  prompt was tuned on. It is a fictional clinic network's patient records and clinical safety
  standard, with 40 obligations and 36 requirements. Two independent agents labelled it blind
  to every arm and prompt, with Cohen's κ 0.93 on whether a rule applies, and a third pass
  settled each disagreement with a written reason. Seven pairs carry a short BA answer
  ("Yes, we do.", "No."). `governing-01` is now marked as the tuning set. Every report says
  which set it read. The held-out set's manifest records a content hash, which the loader
  checks, and the rule is to read that set only for a decision, never to tune a prompt against
  it.
