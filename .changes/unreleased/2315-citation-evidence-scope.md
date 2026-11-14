---
issue: 2315
section: Fixed
---

- Chat's citation check no longer marks a citation verified on evidence the model never saw
  as code. A `path:line` written inside a retrieved document (a spec mentioning
  `app.ts:42`) is no longer counted as code that was read: the fused code block's own
  entries are the only retrieved code evidence. A tool result longer than
  `CHAT_TOOL_RESULT_MAX_TOKENS` counts only as far as the model's capped copy showed whole
  lines, so lines 150-200 of a long `read_file_slice` the cap cut off now read as not
  verified. And a file the answer proposes to create ("create
  `server/src/lib/new-feature.ts`", "`x/y.ts` (new)") is no longer flagged as not read.
