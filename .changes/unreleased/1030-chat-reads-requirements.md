---
issue: 1030
section: Fixed
---

- Chat can now read the project's own requirements. Asked about them, it used
  to search only the knowledge base, find nothing, and say the requirements
  did not exist. Two read-only tools give a project chat that view:
  `list_requirements` lists and filters them by review status, label or words
  in the title and body, and `get_requirement` reads one with its acceptance
  criteria, code links, data (table and column) mappings and its
  requirement-to-spec-to-code trace. Both read only the chat's own project. When
  nothing matches, the reply gives the project's requirement count by status
  rather than implying there are none. A reply that used them shows as grounded
  in the project.
