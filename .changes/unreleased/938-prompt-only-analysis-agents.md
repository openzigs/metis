---
issue: 938
section: Changed
---

- The start-analysis form now lists the enabled custom and library agents that
  the run also invokes. It says they run prompt-only: each gets the project's
  name and description, no documents or code, and none of its tools run. The
  form names each agent's tools that will not run. Tools apply only when a
  chat delegates to the agent, and the agent wizard's Tools step now says
  that analysis runs are prompt-only too.
