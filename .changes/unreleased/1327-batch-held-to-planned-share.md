---
issue: 1327
section: Fixed
---

- A planned BRD holds each catalogue batch to its planned share as it is
  written: the topics past it, least important by the modules they cite, are
  what a length cap takes first. Replayed on the 2026-10-21 DeepSeek run, 84
  topics cut at section ends become 64 and Data Model keeps "Content Entities".
- Each batch is asked for its words divided by the model's overrun
  (`DOCS_GEN_LENGTH_OVERRUN`, built in `deepseek=1.5`, otherwise 1). Upgrading
  rewrites every planned BRD's four catalogue sections once (about $1 for the
  walkthrough BRD on DeepSeek); a BRD with the topic plan off is unchanged.
