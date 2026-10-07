---
issue: 736
section: Fixed
---

- In a project chat, knowledge search now always searches the chat's own project. Before, the
  model had to pass the project's internal id. It passed the project's name instead, so every
  knowledge search failed and used up one of the chat's steps.
- With code-search tools on, chat can now read a range of lines (up to 200) from a file in the
  project's repository, so an answer can quote the code it cites. It reads only the project's
  own repository clones. If no clone is on disk, the model is told it cannot read files.
- If a tool call is cancelled because nobody approved it in time, that step no longer counts
  against the chat's step limit. This happens at most twice per reply, so an unattended chat
  still ends.
