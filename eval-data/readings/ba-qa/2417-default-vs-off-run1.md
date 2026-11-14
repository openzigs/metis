# BA question answering (#2237) — 2026-11-14T20-37-59-068Z-default

Answers: anthropic/claude-sonnet-5-5. Judge: claude-sonnet-5-5.

- **default**: `CHAT_CODE_SEARCH_TOOLS=(unset: default)`, `CHAT_FUSED_CODE_RETRIEVAL=(unset: default)`, `RAG_RERANK=(unset: default)`, `CHAT_CODE_SEARCH_PRIMITIVES=(unset: default)`, `CHAT_CODE_CONTEXT_TOOL=(unset: default)`, `CHAT_CHANGE_HISTORY_TOOL=(unset: default)`
- **off**: `CHAT_CODE_SEARCH_TOOLS=0`, `CHAT_FUSED_CODE_RETRIEVAL=0`, `RAG_RERANK=0`, `CHAT_CODE_SEARCH_PRIMITIVES=0`, `CHAT_CODE_CONTEXT_TOOL=0`, `CHAT_CHANGE_HISTORY_TOOL=0`

| Metric | default | off |
|---|---|---|
| Questions (unscored) | 26 (0) | 26 (0) |
| Sessions chat left unscoped (no retrieval) | 9/26 | 9/26 |
| Correctness: mean facts stated | 53% | 21% |
| Fully correct answers | 28% (5/18) | 0% (0/18) |
| Citation precision: cited lines, judged on the span | 99% (84/85) | n/a |
| Citation precision: file named without lines, judged by file | 19% (3/16) | 23% (9/40) |
| Citations whose span the judge read | 84% (85/101) | 0% (0/40) |
| Citation recall (expected files cited) | 40% (20/50) | 18% (9/50) |
| Abstention on unanswerable | 100% (4/4) | 100% (4/4) |
| Confident guess on unanswerable | 0% (0/4) | 0% (0/4) |
| Follow-up on ambiguous | 75% (3/4) | 100% (4/4) |
| False abstention on answerable | 28% (5/18) | 67% (12/18) |
| Unneeded follow-up on answerable | 6% (1/18) | 0% (0/18) |
| Right behaviour: single-product | 86% (12/14) | 43% (6/14) |
| Right behaviour: multi-product | 0% (0/4) | 0% (0/4) |
| Tool loop out of turns | 2 in 2/26 sessions | 0 in 0/26 sessions |
| Tool results truncated | 6 in 5/26 sessions | 0 in 0/26 sessions |
| Input tokens per question (cache reads included) | 31,615 | 4,539 |
| Seconds per answer (judge excluded) | 9.9 | 6.8 |
| Retrieval ms per question | 101 | 117 |
| Answer spend | $1.0008 | $0.4899 |
| Answer spend per question | $0.0385 | $0.0188 |
| Judge spend | $0.1556 | $0.0756 |
| Total spend | $1.1564 | $0.5655 |

Run total, every model call: $1.721887.

## Per question

| Arm | Question | Expect | Got | Facts | Cites (support) | Expected cited | Scope bound | RAG chars | Tools | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| default | S1 | answer | answer | 3/6 | 5 (2) | 1/3 | yes | 13471 | 5 | $0.0597 |
| default | S2 | answer | answer | 4/5 | 7 (7) | 3/4 | yes | 12897 | 5 | $0.0483 |
| default | S3 | answer | answer | 4/4 | 12 (9) | 3/4 | yes | 16677 | 11 | $0.0744 |
| default | S4 | answer | answer | 3/3 | 6 (6) | 1/1 | yes | 14282 | 5 | $0.0481 |
| default | S5 | answer | answer | 3/4 | 9 (9) | 1/2 | yes | 11543 | 4 | $0.0338 |
| default | S6 | answer | answer | 3/4 | 3 (2) | 1/1 | yes | 14889 | 2 | $0.0270 |
| default | S7 | answer | answer | 3/3 | 9 (9) | 3/3 | yes | 15313 | 11 | $0.0969 |
| default | S8 | answer | answer | 3/3 | 7 (7) | 2/3 | yes | 13621 | 7 | $0.0591 |
| default | S9 | answer | answer | 2/3 | 3 (3) | 2/3 | yes | 11851 | 4 | $0.0359 |
| default | S10 | answer | answer | 0/3 | 16 (15) | 0/3 | yes | 13988 | 15 | $0.1298 |
| default | S11 | answer | answer | 3/3 | 8 (8) | 2/3 | yes | 14077 | 5 | $0.0488 |
| default | M1 | answer | abstain | 0/7 | 0 (0) | 0/8 | no | 0 | 0 | $0.0052 |
| default | M2 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0075 |
| default | M3 | answer | abstain | 0/3 | 0 (0) | 0/3 | no | 0 | 0 | $0.0053 |
| default | M4 | answer | follow-up | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0043 |
| default | A1 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0049 |
| default | A2 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0033 |
| default | A3 | follow-up | answer | - | 6 (6) | - | yes | 15668 | 2 | $0.0439 |
| default | A4 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0041 |
| default | U1 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0037 |
| default | U2 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0051 |
| default | U3 | abstain | abstain | - | 2 (2) | - | yes | 14520 | 2 | $0.0347 |
| default | U4 | abstain | abstain | - | 2 (0) | - | yes | 9174 | 2 | $0.0216 |
| default | H1 | answer | abstain | 1/3 | 4 (2) | 0/1 | yes | 13387 | 8 | $0.0780 |
| default | H2 | answer | answer | 2/3 | 5 (4) | 0/1 | yes | 11624 | 9 | $0.0722 |
| default | H3 | answer | abstain | 0/3 | 7 (4) | 1/1 | yes | 14283 | 4 | $0.0451 |
| off | S1 | answer | abstain | 0/6 | 3 (0) | 0/3 | yes | 13471 | 0 | $0.0315 |
| off | S2 | answer | answer | 2/5 | 1 (1) | 1/4 | yes | 12897 | 0 | $0.0256 |
| off | S3 | answer | abstain | 1/4 | 4 (0) | 0/4 | yes | 16677 | 0 | $0.0325 |
| off | S4 | answer | abstain | 0/3 | 3 (0) | 0/1 | yes | 14282 | 0 | $0.0305 |
| off | S5 | answer | answer | 3/4 | 2 (1) | 1/2 | yes | 11543 | 0 | $0.0196 |
| off | S6 | answer | answer | 3/4 | 2 (1) | 1/1 | yes | 14889 | 0 | $0.0253 |
| off | S7 | answer | abstain | 0/3 | 2 (1) | 1/3 | yes | 15313 | 0 | $0.0300 |
| off | S8 | answer | answer | 1/3 | 4 (2) | 2/3 | yes | 13621 | 0 | $0.0273 |
| off | S9 | answer | answer | 1/3 | 2 (2) | 2/3 | yes | 11851 | 0 | $0.0238 |
| off | S10 | answer | abstain | 0/3 | 5 (0) | 0/3 | yes | 13988 | 0 | $0.0372 |
| off | S11 | answer | abstain | 1/3 | 3 (0) | 0/3 | yes | 14077 | 0 | $0.0243 |
| off | M1 | answer | abstain | 0/7 | 0 (0) | 0/8 | no | 0 | 0 | $0.0052 |
| off | M2 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0062 |
| off | M3 | answer | abstain | 0/3 | 0 (0) | 0/3 | no | 0 | 0 | $0.0072 |
| off | M4 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0056 |
| off | A1 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0048 |
| off | A2 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0037 |
| off | A3 | follow-up | follow-up | - | 1 (0) | - | yes | 15668 | 0 | $0.0252 |
| off | A4 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0042 |
| off | U1 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0036 |
| off | U2 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0047 |
| off | U3 | abstain | abstain | - | 2 (0) | - | yes | 14520 | 0 | $0.0223 |
| off | U4 | abstain | abstain | - | 2 (0) | - | yes | 9174 | 0 | $0.0120 |
| off | H1 | answer | abstain | 1/3 | 2 (0) | 0/1 | yes | 13387 | 0 | $0.0237 |
| off | H2 | answer | answer | 1/3 | 3 (0) | 0/1 | yes | 11624 | 0 | $0.0240 |
| off | H3 | answer | abstain | 0/3 | 4 (1) | 1/1 | yes | 14283 | 0 | $0.0299 |
