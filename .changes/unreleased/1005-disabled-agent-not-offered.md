---
issue: 1005
section: Fixed
---

- A custom agent turned off for a project, including one the project owns, is
  no longer offered to that project's chat, in the agent picker or as a
  hand-off target. A hand-off already offered is refused at once with "Turned
  off for this project" instead of stalling about two minutes on an approval.
  Turning the agent back on restores it.
