---
issue: 289
section: Fixed
---

- Custom agents and enabled library agents that run during an analysis now
  contribute their findings. Before this, the analysis paid for every agent's
  answer and then threw it away, keeping only the token count. Each agent is
  asked for the same findings format the built-in specialists use; its findings
  are saved with the analysis, fed into synthesis alongside the specialists',
  and shown in the Findings list labelled with the agent's name.
- An agent whose answer cannot be read as findings, even after one retry, is
  now shown on the analysis as a failed agent with the reason. It no longer
  disappears without a trace.
- These agents are given no documents or source code, so their findings never
  carry citations, a requirement link, a verification badge or a verdict. The
  server strips those fields from an agent's answer before saving it.
