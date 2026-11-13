---
issue: 2412
section: Fixed
---

- Chat's citation check no longer counts a file locator that sits inside code a tool returned
  (a comment like `// see util.ts:1-500`) as lines that were read. Code-tool evidence now
  comes only from each tool's own header lines. When `search_code_context` is on, it reads
  each file once per call, leaves out a file over 1 MiB (counting it in its notes), and cuts a
  line longer than 500 characters. `search_code_context` stays off by default
  (`CHAT_CODE_CONTEXT_TOOL`). Measured over three paired runs (`pnpm eval:ba-qa --arm
  tools-context` against `tools-only`), it did not improve facts stated or citation precision
  beyond run-to-run spread (`eval-data/README.md`).
