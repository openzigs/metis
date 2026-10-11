---
issue: 1057
section: Fixed
---

- A Spec Kit command (`/speckit.plan` and the others) whose model reply hits
  the output-token limit before writing any text now fails with a clear error
  (`SPEC_KIT_OUTPUT_EXHAUSTED`) and keeps the previous artifact. It used to
  re-send the same prompt and then save a stub that said only "Incomplete".
  A continuation that adds no text is no longer re-sent.
- Spec Kit calls now send an explicit output cap and reasoning effort. New
  admin settings: `SPEC_KIT_MAX_OUTPUT_TOKENS` (default 21333, clamped to the
  model's ceiling) and `SPEC_KIT_REASONING` (default `auto`: `low` effort for a
  model that reasons by default, such as DeepSeek `deepseek-flash`; Claude
  models are unchanged).
