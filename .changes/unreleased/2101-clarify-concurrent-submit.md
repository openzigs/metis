---
issue: 2101
section: Fixed
---

- When the same round of clarifying questions is answered from two places at the same time, such
  as two tabs or a tab and a CSV import, only one set of answers is saved. The other is refused
  and changes nothing. Before, both were accepted and one silently replaced the other.
- When your answers are refused because the round was already answered elsewhere, the panel now
  shows the current questions instead of leaving the closed round on screen with
  **Submit Answers** still enabled.
- After a CSV import, the panel moves to the next step straight away instead of showing the
  answered round until it refreshes.
