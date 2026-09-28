---
issue: 289
section: Fixed
---

- Custom agents and enabled library agents that run during an analysis now
  contribute their findings instead of being paid for and thrown away. Their
  findings are saved, fed into synthesis and shown labelled with the agent's
  name. They carry no citations, verification badge or verdict, because these
  agents see no documents or code.
- An agent whose answer cannot be read as findings, even after one retry, is
  now shown as a failed agent with the reason instead of vanishing.
