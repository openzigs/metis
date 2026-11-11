---
issue: 2243
section: Changed
---

- Chat's code-search tools are now on by default. In a project chat, a discussion's @AI
  reply and the Workbench, the model can search the project's code graph and symbols and
  read up to 200 lines of a file from the project's repository, so an answer about how a
  rule works can quote the code it cites. On the BA question set the share of expected facts
  stated rose from 51% to 73–84%, at about 4 times the input tokens per question. Set
  `CHAT_CODE_SEARCH_TOOLS=false` to turn them off. `CHAT_FUSED_CODE_RETRIEVAL` and
  `RAG_RERANK` stay off: measured one at a time, neither added anything on top of the tools.
- `pnpm eval:ba-qa` takes more arms: `default` (the server's defaults), `no-tools`,
  `no-fused`, `no-rerank` and `tools-only`. `off` now turns the three flags off explicitly.
  The report counts sessions that ran out of tool turns and tool results that were cut.
