---
issue: 2041
section: Fixed
---

- `eval:governing`: a BA answer whose settle failed now counts as a **settle failure**, not
  as "still asking". The settle fails when its call throws or its reply cannot be read
  twice. Before this, one provider outage on the seven-pair short-answer row could move its
  accuracy by about 14 points with no trace. The row's "Replay failures" column is now
  "Requirements failed", and a legend explains both columns. When no run completed, the
  report no longer says the set has no short-answer pairs. It also notes that A4's cost and
  time include the replay, so they cannot be compared with A4 readings from before #2033.
  `governing-02`'s seven `answeredVerdict` labels were re-derived by two blind, tool-less
  labellers. They agreed on all seven and matched the earlier labels, so no label changed.
  The labellers' prompts, labels and agreement are in its `labelling/` folder.
  `governing-01`'s GR-11 question is reworded to cover every January purge, so its
  `compliant` label is no longer contestable.
