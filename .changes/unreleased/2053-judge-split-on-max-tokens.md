---
issue: 2053
section: Fixed
---

- A requirement with many candidate company-policy rules no longer loses its governing check
  when the model's answer runs out of room. The rules are now judged again in smaller groups,
  where the requirement used to be marked as failed.
