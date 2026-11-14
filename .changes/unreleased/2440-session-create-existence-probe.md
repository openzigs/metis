---
issue: 2440
section: Security
---

- Starting a chat no longer tells you whether a project you cannot open exists. A chat scoped to
  a project in a workspace you are not in now starts unscoped with the same "the selected project is
  no longer available" notice as a project that was deleted or never existed, on the one-project and the
  several-products scope alike; before, the first answered "not found" and the second started the
  chat, so anyone holding a project id could tell the two apart. The chat still never reaches
  that project's documents, code, skills or AI provider. A workspace you are not in still
  answers "not found".
