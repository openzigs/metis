---
issue: 727
section: Fixed
---

- The custom-agent playground now says its answer is ungrounded. It runs the
  agent on the prompt alone, so the agent is told it has no access to the
  project, and every answer carries a notice, in the wizard and in the
  `POST /api/custom-agents/:id/invoke` response, naming the tools that did not run.
  Before, an agent asked to cite `file:line` returned invented SQL and a
  non-existent file with no warning.
- The agent tool picker now offers the code tools (`search_code_graph`,
  `search_code_symbols`, `read_file_slice`). The save already accepted them and
  the built-in Architect uses two of them, but no author could select them.
- Findings from custom and library agents in an analysis are now marked
  Unverified. These agents get no documents or code, so their findings have
  no citations. Synthesis now gives them less weight, as it does other
  unverified findings, instead of treating them like cited specialist findings.
