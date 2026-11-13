---
issue: 2279
section: Changed
---

- A chat over several projects now searches with the conversation, as a one-project chat
  does: a follow-up ("and in the client?") or your answer to the model's question is searched
  in every project together with the question before it, and each part of a multi-part
  question is searched. The earlier topic never takes more than 3 of the 8 excerpts, and never
  pushes out a project your own words matched.
- The excerpts an answer cited stay available on your next message, labelled with their
  project, unless you can no longer open that project or see the excerpt.
- Documents attached in the Workbench now limit a multi-project search to those documents.
