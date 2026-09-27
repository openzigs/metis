---
issue: 137
section: Fixed
---

- Chat turns that use tools now record their prompt-cache reads and writes; the
  tool loop dropped them, so cached input was billed at the full input rate.
- A provider that reports no usage is metered on an estimate, marked
  `chat-estimated` on the usage page, instead of as zero tokens.
- The context estimate counts natively-sent tool definitions. A local model
  whose runtime says it cannot take tools is no longer sent them on its first
  call (#195); `LOCAL_GEMMA_DISCOVER_CAPABILITIES=0` turns that probe off.
