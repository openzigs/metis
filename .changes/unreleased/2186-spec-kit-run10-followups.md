---
issue: 2186
section: Fixed
---

- Spec Kit's outcome toast is no longer lost in two cases: a command that ends just as you leave
  the Spec Kit page, and a command the page lost contact with. The app-wide toast now announces
  both when they finish.
- The plan's Check line now reads "x.go is not present in the retrieved context" as saying the file
  is missing (flagged when the file was in the plan's context), and "the source of x.go is not in
  the retrieved context" as saying its source was not shown (flagged only when it was).
- Start analysis from a Spec Kit handoff no longer leaves requirements out to make room for their
  headings: when the spec is long, the headings are shortened first, then reduced to the label.
