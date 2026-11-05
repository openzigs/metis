---
issue: 1823
section: Added
---

- The localization eval now measures table precision for the `IMPACT_AGENT_SEEDS` setting
  (arm A7) before anyone decides whether to turn it on by default.
  `pnpm eval:materialize impact-recall-01-jpetstore` sets up the repository that the
  table corpus models. `--table-guard` then runs a real "Evaluate new requirements" on
  each table requirement and reads table precision with that setting on and off, next to
  the baseline. `--guard-steps` limits how much one call does, so a long reading can be
  continued over several calls.
