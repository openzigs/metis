---
issue: 1051
section: Added
---

- Impact analysis now stores and shows the column proposals it ruled out. Each impacted requirement
  lists **Optional: settings persistence** columns and **Not proposed** columns, with the existing
  function that covers each one (file and line) and the reason. The API item gains
  `droppedColumnProposals` and `optionalColumnProposals`, and the markdown export has both sections.
