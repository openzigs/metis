---
issue: 2326
section: Added
---

- Chat now says when a project's index cannot be trusted. The label under a reply shows each
  repository's last indexed commit and time and how its last indexing run ended, with a warning
  when the index failed, is partial, is still being built or was never built. The model is told
  too, and can call `get_index_status` (`CHAT_INDEX_STATUS`). A failed search now names the
  project and the kind of failure, never the error text. A partial coverage reaches the model.
