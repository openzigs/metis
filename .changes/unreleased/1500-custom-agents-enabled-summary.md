---
issue: 1500
section: Security
---

- The Custom agents card's list of enabled agents no longer returns each agent's
  full definition (system prompt, tools, model) to every project member: it
  returns name, description, built-in badge and owning project only. That read
  and the enable/disable switch are now rate-limited before sign-in is checked.
- Reopening a chat no longer fails when its agent notice cannot be built, and
  the notice and playground message now say "off until enabled" for an agent
  nobody enabled and name a system admin on a project with no workspace.
