---
issue: 1839
section: Added
---

- A requirement can now start from a similar requirement's saved code links, without running an
  analysis. The copied links are labelled as borrowed, name the requirement they came from, and
  carry a lower confidence than the requirement's own analysis links. Only links still known to
  match the code are copied; out-of-date or never-checked links are counted as needing a re-check.
  Borrowing again copies nothing new, and when the requirement's own analysis later links the same
  file, its own link is shown instead. This release adds the server endpoint; the button on the
  similar-requirements panel follows.
