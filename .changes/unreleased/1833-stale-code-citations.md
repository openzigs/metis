---
issue: 1833
section: Added
---

- A requirement's code links now show whether they still point at the right code. Each one reads
  "Up to date", "Moved" (with where it moved from) or "Out of date" (with the reason: the file was
  removed, the function can no longer be found, or the code changed). A summary such as "2 of 6
  code links may be out of date: the code changed since commit abc1234" sits above the list. If you
  can run analyses, "Re-run code evaluation" shows the estimated cost first, then re-runs the code
  analysis for the analysis the requirement came from. On the impact page, the files to edit say
  how many out-of-date code links were set aside.
