---
issue: 346
section: Fixed
---

- Editing a disabled webhook trigger, FinOps alert rule or scheduled job no
  longer re-enables it. Previously, a change that did not mention the enabled
  state (a rename, for example) silently switched it back on, so a trigger you
  had turned off could start firing again.
- Editing one setting no longer resets others you did not touch: a trigger kept
  its configuration (including its webhook signing secret), an alert rule its
  basis and cooldown, a scheduled job its task type, payload and retry limit, a
  project its description, and a repository connector its default branch
  instead of falling back to `main`. Settings already reset by an earlier edit
  are not restored automatically; check them and re-apply where needed.
