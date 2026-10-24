---
issue: 1445
section: Changed
---

- A custom agent is now off until enabled, including one the project owns: chat,
  the agent picker, ACP and analysis runs use it only after **Enable** on the
  Custom agents card, which now shows it as "Off until enabled". The authoring
  wizard's playground can still run a new agent so you can test it first.
  **Upgrading:** owned agents nobody had switched, which chat and ACP used to
  offer, are now off; enable each one you still use.
