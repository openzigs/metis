---
issue: 1845
section: Added
---

- `pnpm eval:chat-cache --budget <usd>` measures the chat caches over the materialized Miniflux
  eval project. It replays a committed set of 40 analyst questions
  (`eval-data/corpus/chatcache-01-miniflux/`), with paraphrase, near-miss and repeat pairs, before
  and after a synthetic re-ingest. It reports input tokens, the cache-read share and the cost per
  session with and without the tool-loop prompt cache (#1842). It also reports the tool-result
  cache's hit rate on each side of the re-ingest (#1843), and the semantic answer cache's hits and
  wrong hits at 0.92, 0.95 and 0.97 (#1844). Wrong hits are scored in code, against the files a
  fresh run cites. Results are written to `eval-results/chat-cache/`.
