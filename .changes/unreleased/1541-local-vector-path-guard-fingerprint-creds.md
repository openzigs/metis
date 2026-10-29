---
issue: 1541
section: Security
---

- Provider API keys and tokens are no longer part of the settings digest recorded with each
  generated document, so rotating a key no longer marks every generated document out of date.
  On a deployment with a provider key configured, each document reads as out of date once after
  upgrading, because its recorded digest still includes the old key. The local vector store
  (`VECTOR_STORE=local`) now refuses any project id that would resolve to a path outside its
  root, including `.`, which could otherwise have dropped every project's table.
