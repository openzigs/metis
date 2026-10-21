---
issue: 1017
section: Fixed
---

- A document generated for a review now shows each requirement as the review pinned it, instead
  of its current text, with a note when it has been edited or deleted since.
- PDF and Word export: the headless Chrome that renders them has no network access. Requests,
  WebSockets and WebRTC are all blocked, and only inline `data:` content loads.
