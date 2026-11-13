# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$20** · Spent: **$0.5795** (judge $0.1495)

Commit: 2d78fb104ca78d325a149fb0e7d857d9c325bbed

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.96 [0.94–0.98] | 1.00 | 1.00 | 0.97 [0.94–1.00] | 0.53 [0.47–0.59] | 1.00 | 102.0 | 19.0 | $0.2150 | 10687 / 19361 | 110.1 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.96 [0.94–0.98] | 1.00 | 1.00 | 0.97 [0.94–1.00] | 0.53 [0.47–0.59] | 1.00 | 102.0 | 19.0 | $0.2150 | 10687 / 19361 | 110.1 | 0 |

- B run 1: missed requirements R104, R105; missed sections 0; ambiguities not raised A4, A5, A8, A9, A10, A12, A13, A16, A17; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R104, R39, R40, R41, R42, R105; missed sections 0; ambiguities not raised A4, A5, A8, A9, A10, A12, A13; repeats 0; judge invalid 0, ungraded 0.

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |
