---
issue: 2346
section: Added
---

- Renaming or moving a source file no longer re-embeds its code symbols; their vectors are reused.
- `pnpm index:consistency --project <id> [--repair]` finds symbols with no vector, vectors with no
  symbol and code indexed at another commit, and repairs the first two; `get_index_status` reports it.
- A new chat tool, `get_file_outline`, lists the symbols one file declares with their line ranges,
  and says when the file is not in the code graph. It is off by default (`CHAT_FILE_OUTLINE_TOOL`).
