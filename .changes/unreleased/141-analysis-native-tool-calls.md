---
issue: 141
section: Changed
---

- Analysis with `ANALYSIS_NATIVE_TOOL_CALLS=true` (still off by default) no
  longer investigates with no tools when the model's runtime rejects native
  tools (for example a local model that "does not support tools"): the agent
  loop switches to the text tool protocol for that pass, and later passes on
  the same model start there. With the flag off nothing changes.
- New `pnpm eval:analysis-tools` runs the analysis code pass on a corpus with
  native tool calls off and on and reports findings validity, degraded-pass
  rate, tool-call errors and tokens per run, so the default can be decided on
  measured numbers (#214). Each pass gets the orchestrator's own prompt blocks
  and token budget. `--dry-run` makes no model call.
