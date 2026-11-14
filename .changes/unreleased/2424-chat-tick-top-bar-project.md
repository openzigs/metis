---
issue: 2424
section: Fixed
---

- Chat's scope picker keeps the top bar's own project ticked under **Chosen products**. Ticking it
  used to leave it unticked and labelled **This project**, and ticking a second project then
  dropped it, so the chat searched only the second one.
- Chat's conversation list names a conversation's scope in the picker's words: **Whole
  workspace: <name>** instead of "Every project in <name>", and **No product chosen** instead of
  "All projects".
