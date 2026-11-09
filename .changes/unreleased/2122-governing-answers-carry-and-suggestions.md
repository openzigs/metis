---
issue: 2122
section: Fixed
---

- One answer to a company-policy question now settles the same fact on the analysis's other
  requirements. Requirements that wait on one fact ask about it in different words; before,
  answering one left the others waiting and the next round asked the fact again. METIS now checks
  each answer against the other requirements still unsure whether a rule applies, and uses it
  only where the fact holds for that requirement too.
- Suggested answers in the clarifying questions are offered, not filled in. A suggestion is shown
  under its question with **Use suggested answer**, is not counted as answered, and is sent only
  if you use it. Before, suggestions filled the answer boxes, counted as answered and were all
  sent with **Submit Answers**, so a wrong suggestion could settle a governing finding by
  accident.
- A governing finding's reason no longer names a rule by the internal label the model was given
  ("Whether R1 is met…"); it says "this rule", or the other rule's control id.
- The Governing rules summary states the rules that apply and the gaps in separate sentences:
  "5 of 26 rules in NIST SP 800-63B-4 apply. 4 gaps found; 3 rules need BA input." The old
  "4 gaps found against 5 of 26 applicable rules" read as five rules with gaps.
