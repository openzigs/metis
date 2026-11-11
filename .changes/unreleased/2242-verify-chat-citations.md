---
issue: 2242
section: Added
---

- Chat and Workbench check every citation in an answer against what the turn retrieved or read: the
  excerpts it was given, the fused code block, and the files and line ranges its code and knowledge
  tools returned. A verified citation of the project's code links to the file on GitHub at the cited
  lines; a citation of a file the turn never read, or of lines it never read, is marked under the
  reply, live and after a reload. A citation an earlier turn of the same chat read is marked as read
  earlier in the conversation, not as unread.
