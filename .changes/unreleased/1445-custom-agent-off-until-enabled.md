---
issue: 1445
section: Changed
---

- A custom agent is now off until enabled, including one the project owns: chat,
  the agent picker, ACP and analysis runs use it only after **Enable** on the
  Custom agents card, which now shows it as "Off until enabled". In the
  authoring wizard's playground a workspace admin can still test a new agent.
  **Upgrading:** owned agents nobody had switched, which chat and ACP used to
  offer, are now off; enable each one you still use. A reopened chat bound to
  one says so.
