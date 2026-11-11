---
issue: 2238
section: Added
---

- Chat can now be scoped to several projects at once, or to every project in your workspace, and
  answers from all of them. Before, picking two projects silently left the chat unscoped and it
  answered from the model's general knowledge. Each turn searches every project in the scope
  (checking your access to each again), leaves out a project that has nothing relevant to the
  question, labels every excerpt with its project and tells the model to say which project each
  statement comes from. A project whose search timed out is named in the answer and on the
  grounding label, never silently dropped. The label under each reply lists the projects the
  answer drew on and the ones it could not search.
