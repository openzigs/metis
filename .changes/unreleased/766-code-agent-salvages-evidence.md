---
issue: 766
section: Fixed
---

- A code agent that runs out of token budget no longer ends with 0 findings when
  its final answer fails. One last tool-free call now works from the files and
  code searches it already retrieved, so the investigation is not thrown away.
- Regenerate on the code agent re-runs the same agentic, tool-using pass the
  analysis used, instead of a weaker single retrieval call.
- The Agent output tab badges a code agent that finished degraded as `degraded`,
  not a green `completed`.
