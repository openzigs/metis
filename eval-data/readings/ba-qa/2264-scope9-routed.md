# BA question answering (#2237) — 2026-11-13T15-52-20-058Z-default-scope9-routed

Commit: e8ce629be5d713757f9d770e44f8da06ada9f2f9

Answers: anthropic/claude-sonnet-5-5. Judge: claude-sonnet-5-5.

- **default-scope9-routed**: `CHAT_CODE_SEARCH_TOOLS=(unset: default)`, `CHAT_FUSED_CODE_RETRIEVAL=(unset: default)`, `RAG_RERANK=(unset: default)`, `CHAT_CODE_SEARCH_PRIMITIVES=(unset: default)`, `routingScope=9`, `route=routed`

| Metric | default-scope9-routed |
|---|---|
| Questions (unscored) | 10 (0) |
| Sessions chat left unscoped (no retrieval) | 0/10 |
| Correctness: mean facts stated | 28% |
| Fully correct answers | 10% (1/10) |
| Citation precision: cited lines, judged on the span | n/a |
| Citation precision: file named without lines, judged by file | 35% (9/26) |
| Citations whose span the judge read | 0% (0/26) |
| Citation recall (expected files cited) | 28% (9/32) |
| Abstention on unanswerable | n/a |
| Confident guess on unanswerable | n/a |
| Follow-up on ambiguous | n/a |
| False abstention on answerable | 60% (6/10) |
| Unneeded follow-up on answerable | 0% (0/10) |
| Right behaviour: single-product | 33% (2/6) |
| Right behaviour: multi-product | 50% (2/4) |
| Tool loop out of turns | 0 in 0/10 sessions |
| Tool results truncated | 0 in 0/10 sessions |
| Input tokens per question (cache reads included) | 5,535 |
| Seconds per question | 9.1 |
| Retrieval ms per question | 181 |
| Answer spend | $0.2366 |
| Answer spend per question | $0.0237 |
| Judge spend | $0.0349 |
| Total spend | $0.2716 |

Run total, every model call: $0.271591.

## Per question

| Arm | Question | Expect | Got | Facts | Cites (support) | Expected cited | Scope bound | RAG chars | Tools | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| default-scope9-routed | S1 | answer | answer | 3/6 | 3 (1) | 1/3 | 2 of 9 products (routed) | 10608 | 0 | $0.0269 |
| default-scope9-routed | S2 | answer | abstain | 0/5 | 2 (0) | 0/4 | 2 of 9 products (routed) | 9162 | 0 | $0.0178 |
| default-scope9-routed | S3 | answer | abstain | 1/4 | 4 (1) | 1/4 | 3 of 9 products (routed) | 15644 | 0 | $0.0294 |
| default-scope9-routed | S4 | answer | abstain | 0/3 | 3 (0) | 0/1 | 2 of 9 products (routed) | 14524 | 0 | $0.0307 |
| default-scope9-routed | S5 | answer | abstain | 0/4 | 2 (1) | 1/2 | 2 of 9 products (routed) | 13360 | 0 | $0.0249 |
| default-scope9-routed | S6 | answer | answer | 1/4 | 1 (1) | 1/1 | 2 of 9 products (routed) | 12963 | 0 | $0.0248 |
| default-scope9-routed | M1 | answer | answer | 3/7 | 1 (1) | 1/8 | 7 of 9 products (routed) | 8072 | 0 | $0.0211 |
| default-scope9-routed | M2 | answer | abstain | 0/2 | 2 (0) | 0/3 | 3 of 9 products (routed) | 6814 | 0 | $0.0185 |
| default-scope9-routed | M3 | answer | abstain | 1/3 | 3 (1) | 1/3 | 2 of 9 products (routed) | 6299 | 0 | $0.0169 |
| default-scope9-routed | M4 | answer | answer | 2/2 | 5 (3) | 3/3 | 5 of 9 products (routed) | 12778 | 0 | $0.0256 |
