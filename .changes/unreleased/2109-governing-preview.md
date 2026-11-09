---
issue: 2109
section: Changed
---

- Governing checks are marked **Preview**. The workspace **Governing documents**
  tab, the analysis view's **Governing rules** panel and the BRD's governing-rules
  section each show a Preview badge and the note "Governing checks can miss rules
  or flag ones that don't apply. Review each finding before relying on it." The
  checks stay on by default. The mark stays until the held-out real-policy
  measurement passes its bars; its first reading failed three of five (recall
  0.80, recall on rules that share no words with the requirement 0.50,
  precision 0.52).
