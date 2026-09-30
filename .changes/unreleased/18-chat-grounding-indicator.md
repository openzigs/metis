---
issue: 18
section: Added
---

- Every chat reply now says what it was based on: "Grounded in _Project_ · N
  sources", "Not grounded — nothing relevant was found in _Project_", or "Not
  grounded — no project selected". The label is stored with the reply, so it is
  still there after a reload.
- A chat scoped to "All projects" now says plainly, before you send anything,
  that it does not search your projects and answers come from the model's
  general knowledge. Previously it looked grounded and was not.
- If you have never picked a chat scope and can reach exactly one project, chat
  now starts scoped to that project instead of "All projects".
