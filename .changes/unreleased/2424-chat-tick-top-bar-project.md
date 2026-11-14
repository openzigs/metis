---
issue: 2424
section: Fixed
---

- **Whole workspace** in chat and impact analysis now means the workspace's own projects. Before,
  chat's count and impact analysis's selection also took in every project in no workspace, for
  example "(17 products)" for a workspace of 2, and impact analysis then ran on all of them.
- Chat's scope picker keeps the top bar's own project ticked under **Chosen products**. Ticking it
  used to leave it unticked and labelled **This project**, and ticking a second project then
  dropped it, so the chat searched only the second one.
- Chat's conversation list names a conversation's scope in the picker's words: **Whole
  workspace: <name>** instead of "Every project in <name>", and **No product chosen** instead of
  "All projects".
