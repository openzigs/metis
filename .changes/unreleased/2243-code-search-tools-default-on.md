---
issue: 2243
section: Changed
---

- Chat's code-search tools are on by default (project chat, discussion @AI replies, Workbench):
  the model can search the code graph and symbols and quote up to 200 lines of a repository file.
  BA question set: expected facts stated rose from 51% to 73–84%, at about 4x the input tokens.
  Set `CHAT_CODE_SEARCH_TOOLS=false` to turn them off; `CHAT_FUSED_CODE_RETRIEVAL` and `RAG_RERANK` stay off.
- The code tools honour document access restrictions: a repository file whose document you cannot
  see is not read or listed, and a discussion or Teams reply leaves out every restricted file.
- `pnpm eval:ba-qa` adds the arms `default`, `no-tools`, `no-fused`, `no-rerank` and `tools-only`,
  and reports sessions that ran out of tool turns and tool results that were cut.
