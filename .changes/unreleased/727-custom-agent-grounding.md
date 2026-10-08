---
issue: 727
section: Fixed
---

- The custom-agent playground now marks every answer as ungrounded and names
  the tools that did not run, because it runs on the prompt alone.
- The agent tool picker now offers the code tools (`search_code_graph`,
  `search_code_symbols`, `read_file_slice`).
- Findings from custom and library agents in an analysis, which carry no
  citations, get a new "Not checked against code" status (`ungrounded`), so
  synthesis gives them less weight and the badge says what actually happened.
