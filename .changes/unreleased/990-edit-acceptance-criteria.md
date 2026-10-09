---
issue: 990
section: Fixed
---

- You can now edit a requirement's acceptance criteria. The Edit requirement dialog lists each
  criterion with Add and Remove controls. Each change is recorded as a new version, like an edit to
  the body: it appears in the requirement's history, a restore brings the earlier list back, and a
  conflicting edit opens the merge dialog. Issue drafts render the edited list in place of the
  generated criteria. When a requirement has no stored list, the dialog starts from the criteria the
  draft would take from its body (an imported "Acceptance criteria" section or a Gherkin body), and
  removing them all keeps the published issue free of them.
