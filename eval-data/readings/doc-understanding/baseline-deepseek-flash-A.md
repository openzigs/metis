# Document understanding eval (#2229)

Model: **anthropic/deepseek-flash** · Judge: **anthropic/deepseek-flash** · Runs requested: **1** · Budget: **$2** · Spent: **$0.1398** (judge $0.0719)

Commit: 8a0601902972f33ebde129dce9a15d7e467e01c2

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.27 [0.16–0.37] | 0.65 [0.61–0.68] | 0.32 [0.17–0.42] | 0.50 [0.37–0.65] | 0.19 [0.00–0.36] | n/a | 25.7 | 36.7 | $0.0226 | 4109 / 18137 | 91.4 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 46 labelled requirements in 12 sections, 11 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.37 | 0.68 | 0.42 | 0.47 | 0.36 | n/a | 25.0 | 34.0 | $0.0254 | 4159 / 20526 | 102.9 | 0 |

- A run 1: missed requirements R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R24, R25, R26, R27, R28, R29, R31, R32, R37, R38, R39, R40, R41, R42, R43, R44; missed sections 7; ambiguities not raised A1, A4, A6, A7, A8, A10, A11; repeats 2; judge invalid 0, ungraded 0. Read 9463 of 22129 characters (10 of 26 chunks); the agent extracted 24 requirements and 6 findings.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 58 labelled requirements in 16 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.29 | 0.61 | 0.38 | 0.65 | 0.00 | n/a | 28.0 | 49.0 | $0.0235 | 4249 / 18788 | 90.3 | 0 |

- A run 1: missed requirements R6, R8, R9, R10, R11, R12, R14, R15, R16, R17, R18, R19, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35, R36, R37, R39, R40, R41, R42, R43, R44, R45, R46, R47, R48, R49, R50, R51, R52, R53, R54, R55; missed sections 10; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 8; judge invalid 0, ungraded 0. Read 9611 of 23478 characters (10 of 36 chunks); the agent extracted 28 requirements and 4 findings.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 102 labelled requirements in 30 sections, 14 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A | 0.16 | 0.67 | 0.17 | 0.37 | 0.21 | n/a | 24.0 | 27.0 | $0.0190 | 3919 / 15096 | 81.1 | 0 |

- A run 1: missed requirements R2, R3, R4, R6, R7, R13, R14, R15, R16, R17, R18, R19, R20, R21, R22, R23, R24, R25, R26, R27, R28, R29, R30, R31, R32, R33, R34, R35, R36, R37, R38, R39, R40, R41, R42, R43, R44, R45, R46, R47, R48, R49, R50, R51, R52, R57, R58, R59, R60, R61, R62, R63, R64, R65, R66, R67, R68, R69, R70, R71, R72, R73, R74, R75, R76, R77, R78, R79, R81, R82, R83, R84, R89, R90, R91, R92, R93, R94, R95, R96, R97, R98, R99, R100, R101, R102; missed sections 25; ambiguities not raised A2, A3, A5, A6, A7, A8, A9, A10, A11, A13, A14; repeats 2; judge invalid 0, ungraded 0. Read 8170 of 35075 characters (10 of 54 chunks); the agent extracted 24 requirements and 7 findings.

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
| model | anthropic/deepseek-flash |
