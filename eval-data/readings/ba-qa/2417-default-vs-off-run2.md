# BA question answering (#2237) — 2026-11-14T20-47-04-799Z-default

Answers: anthropic/claude-sonnet-5-5. Judge: claude-sonnet-5-5.

- **default**: `CHAT_CODE_SEARCH_TOOLS=(unset: default)`, `CHAT_FUSED_CODE_RETRIEVAL=(unset: default)`, `RAG_RERANK=(unset: default)`, `CHAT_CODE_SEARCH_PRIMITIVES=(unset: default)`, `CHAT_CODE_CONTEXT_TOOL=(unset: default)`, `CHAT_CHANGE_HISTORY_TOOL=(unset: default)`
- **off**: `CHAT_CODE_SEARCH_TOOLS=0`, `CHAT_FUSED_CODE_RETRIEVAL=0`, `RAG_RERANK=0`, `CHAT_CODE_SEARCH_PRIMITIVES=0`, `CHAT_CODE_CONTEXT_TOOL=0`, `CHAT_CHANGE_HISTORY_TOOL=0`

| Metric | default | off |
|---|---|---|
| Questions (unscored) | 26 (0) | 26 (0) |
| Sessions chat left unscoped (no retrieval) | 9/26 | 9/26 |
| Correctness: mean facts stated | 51% | 22% |
| Fully correct answers | 22% (4/18) | 0% (0/18) |
| Citation precision: cited lines, judged on the span | 96% (89/93) | n/a |
| Citation precision: file named without lines, judged by file | 21% (4/19) | 24% (9/38) |
| Citations whose span the judge read | 83% (93/112) | 0% (0/38) |
| Citation recall (expected files cited) | 40% (20/50) | 18% (9/50) |
| Abstention on unanswerable | 100% (4/4) | 100% (4/4) |
| Confident guess on unanswerable | 0% (0/4) | 0% (0/4) |
| Follow-up on ambiguous | 100% (4/4) | 100% (4/4) |
| False abstention on answerable | 33% (6/18) | 67% (12/18) |
| Unneeded follow-up on answerable | 0% (0/18) | 0% (0/18) |
| Right behaviour: single-product | 86% (12/14) | 43% (6/14) |
| Right behaviour: multi-product | 0% (0/4) | 0% (0/4) |
| Tool loop out of turns | 1 in 1/26 sessions | 0 in 0/26 sessions |
| Tool results truncated | 6 in 5/26 sessions | 0 in 0/26 sessions |
| Input tokens per question (cache reads included) | 33,539 | 4,539 |
| Seconds per answer (judge excluded) | 10.1 | 7 |
| Retrieval ms per question | 133 | 297 |
| Answer spend | $1.0153 | $0.4891 |
| Answer spend per question | $0.0391 | $0.0188 |
| Judge spend | $0.1458 | $0.0763 |
| Total spend | $1.1611 | $0.5654 |

Run total, every model call: $1.726542.

## Per question

| Arm | Question | Expect | Got | Facts | Cites (support) | Expected cited | Scope bound | RAG chars | Tools | Cost |
|---|---|---|---|---|---|---|---|---|---|---|
| default | S1 | answer | answer | 3/6 | 10 (8) | 1/3 | yes | 13471 | 8 | $0.0735 |
| default | S2 | answer | answer | 4/5 | 8 (7) | 2/4 | yes | 12897 | 8 | $0.0555 |
| default | S3 | answer | answer | 4/4 | 11 (6) | 3/4 | yes | 16677 | 7 | $0.0698 |
| default | S4 | answer | answer | 3/3 | 11 (11) | 1/1 | yes | 14282 | 7 | $0.0531 |
| default | S5 | answer | answer | 3/4 | 11 (11) | 1/2 | yes | 11543 | 4 | $0.0355 |
| default | S6 | answer | answer | 3/4 | 5 (4) | 1/1 | yes | 14889 | 2 | $0.0279 |
| default | S7 | answer | answer | 3/3 | 7 (7) | 3/3 | yes | 15313 | 8 | $0.0726 |
| default | S8 | answer | answer | 3/3 | 11 (10) | 3/3 | yes | 13621 | 10 | $0.0767 |
| default | S9 | answer | answer | 2/3 | 4 (3) | 2/3 | yes | 11851 | 4 | $0.0371 |
| default | S10 | answer | answer | 0/3 | 9 (6) | 0/3 | yes | 13988 | 14 | $0.1354 |
| default | S11 | answer | answer | 2/3 | 10 (10) | 2/3 | yes | 14077 | 7 | $0.0605 |
| default | M1 | answer | abstain | 0/7 | 0 (0) | 0/8 | no | 0 | 0 | $0.0053 |
| default | M2 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0046 |
| default | M3 | answer | abstain | 0/3 | 0 (0) | 0/3 | no | 0 | 0 | $0.0052 |
| default | M4 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0045 |
| default | A1 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0047 |
| default | A2 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0041 |
| default | A3 | follow-up | follow-up | - | 5 (5) | - | yes | 15668 | 2 | $0.0385 |
| default | A4 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0046 |
| default | U1 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0040 |
| default | U2 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0048 |
| default | U3 | abstain | abstain | - | 2 (2) | - | yes | 14520 | 3 | $0.0367 |
| default | U4 | abstain | abstain | - | 3 (2) | - | yes | 9174 | 2 | $0.0216 |
| default | H1 | answer | abstain | 1/3 | 3 (2) | 0/1 | yes | 13387 | 9 | $0.0848 |
| default | H2 | answer | answer | 2/3 | 5 (4) | 0/1 | yes | 11624 | 5 | $0.0556 |
| default | H3 | answer | abstain | 0/3 | 7 (4) | 1/1 | yes | 14283 | 3 | $0.0385 |
| off | S1 | answer | abstain | 0/6 | 4 (1) | 1/3 | yes | 13471 | 0 | $0.0282 |
| off | S2 | answer | answer | 2/5 | 1 (1) | 1/4 | yes | 12897 | 0 | $0.0256 |
| off | S3 | answer | abstain | 0/4 | 4 (0) | 0/4 | yes | 16677 | 0 | $0.0347 |
| off | S4 | answer | abstain | 0/3 | 2 (0) | 0/1 | yes | 14282 | 0 | $0.0307 |
| off | S5 | answer | answer | 3/4 | 2 (1) | 1/2 | yes | 11543 | 0 | $0.0199 |
| off | S6 | answer | answer | 3/4 | 2 (1) | 1/1 | yes | 14889 | 0 | $0.0258 |
| off | S7 | answer | abstain | 0/3 | 2 (1) | 1/3 | yes | 15313 | 0 | $0.0301 |
| off | S8 | answer | answer | 2/3 | 3 (1) | 1/3 | yes | 13621 | 0 | $0.0276 |
| off | S9 | answer | answer | 1/3 | 2 (2) | 2/3 | yes | 11851 | 0 | $0.0237 |
| off | S10 | answer | abstain | 0/3 | 5 (0) | 0/3 | yes | 13988 | 0 | $0.0350 |
| off | S11 | answer | abstain | 1/3 | 3 (0) | 0/3 | yes | 14077 | 0 | $0.0258 |
| off | M1 | answer | abstain | 0/7 | 0 (0) | 0/8 | no | 0 | 0 | $0.0050 |
| off | M2 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0054 |
| off | M3 | answer | abstain | 0/3 | 0 (0) | 0/3 | no | 0 | 0 | $0.0054 |
| off | M4 | answer | abstain | 0/2 | 0 (0) | 0/3 | no | 0 | 0 | $0.0042 |
| off | A1 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0045 |
| off | A2 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0039 |
| off | A3 | follow-up | follow-up | - | 1 (0) | - | yes | 15668 | 0 | $0.0255 |
| off | A4 | follow-up | follow-up | - | 0 (0) | - | no | 0 | 0 | $0.0044 |
| off | U1 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0042 |
| off | U2 | abstain | abstain | - | 0 (0) | - | no | 0 | 0 | $0.0048 |
| off | U3 | abstain | abstain | - | 2 (0) | - | yes | 14520 | 0 | $0.0226 |
| off | U4 | abstain | abstain | - | 1 (0) | - | yes | 9174 | 0 | $0.0122 |
| off | H1 | answer | abstain | 1/3 | 2 (0) | 0/1 | yes | 13387 | 0 | $0.0249 |
| off | H2 | answer | answer | 1/3 | 2 (0) | 0/1 | yes | 11624 | 0 | $0.0247 |
| off | H3 | answer | abstain | 0/3 | 4 (1) | 1/1 | yes | 14283 | 0 | $0.0302 |
