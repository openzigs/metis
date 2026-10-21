---
issue: 1017
section: Fixed
---

- A document generated for a review now shows each requirement as the review pinned it, with a
  note when the requirement has changed since, instead of its current text.
- PDF and Word export: the headless Chrome page now blocks every request except `data:` URLs, so
  exported content cannot make the server fetch anything.
