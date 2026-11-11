# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$13** · Spent: **$3.7157** (judge $0.6418)

Commit: 8a0601902972f33ebde129dce9a15d7e467e01c2

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.26 [0.14–0.37] | 0.74 [0.61–0.81] | 0.27 [0.13–0.42] | 0.27 [0.16–0.33] | 0.28 [0.08–0.55] | n/a | 21.0 | 48.3 | $0.1213 | 7651 / 10604 | 67.1 | 0 |
| B | 1.00 | 0.93 [0.88–0.97] | 1.00 | 1.00 | 0.69 [0.50–0.91] | 1.00 | 73.0 | 12.0 | $0.2002 | 12197 / 17577 | 97.2 | 0 |
| C | 0.99 [0.96–1.00] | 0.59 [0.57–0.61] | 1.00 | 0.36 [0.29–0.41] | 0.92 [0.91–0.93] | 1.00 | 113.3 | 78.0 | $0.7031 | 122562 / 45802 | 143.0 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 46 labelled requirements in 12 sections, 11 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.37 | 0.81 | 0.42 | 0.33 | 0.55 | n/a | 21.0 | 58.0 | $0.1330 | 7850 / 11727 | 73.4 | 0 |
| B | 1.00 | 0.88 | 1.00 | 1.00 | 0.91 | 1.00 | 52.0 | 11.0 | $0.1074 | 7010 / 9341 | 52.1 | 0 |
| C | 1.00 | 0.61 | 1.00 | 0.41 | 0.91 | 1.00 | 76.0 | 63.0 | $0.4639 | 75496 / 31290 | 88.4 | 0 |

- A run 1: missed requirements R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R24, R25, R26, R27, R28, R29, R31, R32, R37, R38, R39, R40, R41, R42, R43, R44; missed sections 7; ambiguities not raised A1, A6, A7, A8, A10; repeats 1; judge invalid 0, ungraded 0. Read 9463 of 22129 characters (10 of 26 chunks); the agent extracted 21 requirements and 4 findings.

- B run 1: missed requirements none; missed sections 0; ambiguities not raised A9; repeats 0; judge invalid 0, ungraded 0.

- C run 1: missed requirements none; missed sections 0; ambiguities not raised A8; repeats 13; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 58 labelled requirements in 16 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.26 | 0.79 | 0.25 | 0.32 | 0.08 | n/a | 19.0 | 44.0 | $0.1182 | 7768 / 10268 | 66.6 | 0 |
| B | 1.00 | 0.97 | 1.00 | 1.00 | 0.67 | 1.00 | 60.0 | 12.0 | $0.1267 | 7392 / 11188 | 61.3 | 0 |
| C | 1.00 | 0.57 | 1.00 | 0.38 | 0.92 | 1.00 | 102.0 | 79.0 | $0.5646 | 104802 / 35496 | 102.1 | 0 |

- A run 1: missed requirements R6, R7, R8, R9, R10, R11, R12, R13, R14, R15, R16, R17, R18, R19, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R44, R45, R46, R47, R48, R49, R50, R51, R52, R53, R54, R55; missed sections 12; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11; repeats 2; judge invalid 0, ungraded 0. Read 9611 of 23478 characters (10 of 36 chunks); the agent extracted 19 requirements and 4 findings.

- B run 1: missed requirements none; missed sections 0; ambiguities not raised A7, A9, A10, A12; repeats 1; judge invalid 0, ungraded 0.

- C run 1: missed requirements none; missed sections 0; ambiguities not raised A9; repeats 29; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 102 labelled requirements in 30 sections, 14 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.14 | 0.61 | 0.13 | 0.16 | 0.21 | n/a | 23.0 | 43.0 | $0.1128 | 7334 / 9817 | 61.2 | 0 |
| B | 1.00 | 0.95 | 1.00 | 1.00 | 0.50 | 1.00 | 107.0 | 13.0 | $0.3664 | 22188 / 32201 | 178.2 | 0 |
| C | 0.96 | 0.60 | 1.00 | 0.29 | 0.93 | 1.00 | 162.0 | 92.0 | $1.0810 | 187389 / 70619 | 238.5 | 0 |

- A run 1: missed requirements R1, R2, R3, R4, R5, R6, R7, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R47, R48, R49, R50, R51, R52, R57, R58, R59, R60, R61, R62, R63, R64, R65, R66, R67, R68, R69, R70, R71, R72, R73, R74, R75, R76, R77, R78, R79, R81, R82, R83, R84, R89, R90, R91, R92, R93, R94, R95, R96, R97, R98, R99, R100, R101, R102; missed sections 26; ambiguities not raised A2, A3, A4, A6, A7, A8, A9, A10, A11, A13, A14; repeats 3; judge invalid 0, ungraded 0. Read 8170 of 35075 characters (10 of 54 chunks); the agent extracted 22 requirements and 4 findings.

- B run 1: missed requirements none; missed sections 0; ambiguities not raised A4, A5, A7, A8, A9, A12, A13; repeats 3; judge invalid 0, ungraded 0.

- C run 1: missed requirements R39, R40, R41, R42; missed sections 0; ambiguities not raised A4; repeats 44; judge invalid 0, ungraded 0.

## Arms

### A — today's document agent over 10 retrieved chunks, then structured extraction

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| chunker | chunkMarkdown (rag/chunker.ts), default options |
| retrieval | buildRetrievalQueries(document) + runGroundedRetrieval (RRF), document title as the project name |
| searcher | production BM25 options (createInMemoryBM25), no vectors; padded to k with unmatched chunks in document order |
| k | 10 |
| rerank | false |
| agent | runAgent document (analysis/agent-runner.ts) |
| requirements | RequirementsExtractor over the agent's requirement texts, else its findings (runEnhancementPipeline) |
| questions | the extracted requirements' ambiguities, suggestedQuestion |
| model | anthropic/claude-sonnet-5-5 |

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |

### C — section by section with a document summary, glossary and actors, then a reduce

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| context | one call over the whole document: summary, glossary, actors |
| sections | splitSections (governing/rule-extraction.ts): every heading, long sections split |
| reduce | one call: drop repeated requirements, settle and add cross-section questions |
| model | anthropic/claude-sonnet-5-5 |
