# BA question answering (#2237) — 2026-11-13T15-49-01-057Z-default-scope9-all

Commit: e8ce629be5d713757f9d770e44f8da06ada9f2f9

Answers: anthropic/claude-sonnet-5-5. Judge: claude-sonnet-5-5.

- **default-scope9-all**: `CHAT_CODE_SEARCH_TOOLS=(unset: default)`, `CHAT_FUSED_CODE_RETRIEVAL=(unset: default)`, `RAG_RERANK=(unset: default)`, `CHAT_CODE_SEARCH_PRIMITIVES=(unset: default)`, `routingScope=9`, `route=all`

| Metric | default-scope9-all |
|---|---|
| Questions (unscored) | 10 (0) |
| Sessions chat left unscoped (no retrieval) | 0/10 |
| Correctness: mean facts stated | 23% |
| Fully correct answers | 0% (0/10) |
| Citation precision: cited lines, judged on the span | n/a |
| Citation precision: file named without lines, judged by file | 37% (10/27) |
| Citations whose span the judge read | 0% (0/27) |
| Citation recall (expected files cited) | 31% (10/32) |
| Abstention on unanswerable | n/a |
| Confident guess on unanswerable | n/a |
| Follow-up on ambiguous | n/a |
| False abstention on answerable | 50% (5/10) |
| Unneeded follow-up on answerable | 0% (0/10) |
| Right behaviour: single-product | 33% (2/6) |
| Right behaviour: multi-product | 75% (3/4) |
| Tool loop out of turns | 0 in 0/10 sessions |
| Tool results truncated | 0 in 0/10 sessions |
| Input tokens per question (cache reads included) | 5,832 |
| Seconds per question | 9.3 |
| Retrieval ms per question | 96 |
| Answer spend | $0.2417 |
| Answer spend per question | $0.0242 |
| Judge spend | $0.0342 |
| Total spend | $0.2759 |

Run total, every model call: $0.275918.

## Per question

| Arm | Question | Expect | Got | Facts | Cites (support) | Expected cited | Scope bound | RAG chars | Tools | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| default-scope9-all | S1 | answer | answer | 3/6 | 2 (1) | 1/3 | 9 of 9 products (all) | 11481 | 0 | $0.0250 |
| default-scope9-all | S2 | answer | abstain | 0/5 | 2 (0) | 0/4 | 9 of 9 products (all) | 11583 | 0 | $0.0203 |
| default-scope9-all | S3 | answer | abstain | 1/4 | 6 (1) | 1/4 | 9 of 9 products (all) | 16542 | 0 | $0.0298 |
| default-scope9-all | S4 | answer | abstain | 0/3 | 2 (0) | 0/1 | 9 of 9 products (all) | 15486 | 0 | $0.0326 |
| default-scope9-all | S5 | answer | abstain | 0/4 | 2 (1) | 1/2 | 9 of 9 products (all) | 14322 | 0 | $0.0244 |
| default-scope9-all | S6 | answer | answer | 1/4 | 1 (1) | 1/1 | 9 of 9 products (all) | 13925 | 0 | $0.0260 |
| default-scope9-all | M1 | answer | answer | 3/7 | 1 (1) | 1/8 | 9 of 9 products (all) | 8232 | 0 | $0.0211 |
| default-scope9-all | M2 | answer | abstain | 0/2 | 2 (0) | 0/3 | 9 of 9 products (all) | 7525 | 0 | $0.0180 |
| default-scope9-all | M3 | answer | answer | 1/3 | 4 (2) | 2/3 | 9 of 9 products (all) | 7252 | 0 | $0.0176 |
| default-scope9-all | M4 | answer | answer | 1/2 | 5 (3) | 3/3 | 9 of 9 products (all) | 13032 | 0 | $0.0268 |
