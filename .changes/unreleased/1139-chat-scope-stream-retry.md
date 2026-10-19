---
issue: 1139
section: Fixed
---

- Chat opens on the project active in the top bar, and the Workbench opens on
  it too. Chat's own stored project is used only when no project is active. A
  chat last left open under **All projects** comes back under All projects.
- Opening Chat or clicking New chat no longer saves an empty "New Chat"; a chat
  is saved when its first message is sent. Recent lists each chat by its title.
- A model stream that drops mid-answer is retried once from the last completed
  step instead of failing the turn. A turn that still fails keeps its partial
  answer and offers Retry.
- Over `POST /api/ai/chat` with nobody to approve, tools that need approval are
  not offered to the model; the response names them in `toolsWithheld`.
