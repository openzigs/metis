---
issue: 2232
section: Fixed
---

- An uploaded Word document keeps its structure. Requirement and heading numbers stay as Word
  shows them (`3.2.1`, `(a)`, `REQ-12` when Word generates it) instead of becoming bullets, nested
  lists keep their nesting, and tables stay tables. Each embedded image is kept in place as a
  numbered image: when the project's model can read images it is described there, otherwise it is
  listed as "image not read" with the reason. Reviewer comments are kept as notes, tracked changes
  are shown accepted with the deleted text listed, and a "Conversion notes" section at the end says
  what was not carried, so nothing is dropped without a notice. With the Anthropic provider, an
  image sent for description now reaches the model; it was previously sent as text only.
