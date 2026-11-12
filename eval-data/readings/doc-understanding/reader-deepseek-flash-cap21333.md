# Document understanding eval (#2229)

Model: **anthropic/deepseek-flash** · Judge: **anthropic/deepseek-flash** · Runs requested: **1** · Budget: **$8** · Spent: **$0.8281** (judge $0.0905)

Commit: 658a61dc26c145a31cdfed08485489713cc16c41

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.96 | 0.96 | 0.92 | 1.00 | 0.83 | 1.00 | 56.0 | 12.0 | $0.0521 | 15254 / 42444 | 190.6 | 3 |
| R | 1.00 [0.98–1.00] | 0.56 [0.52–0.62] | 1.00 | n/a | 0.00 | 1.00 | 199.3 | 0.0 | $0.1323 | 41128 / 102604 | 498.0 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 56 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.96 | 0.96 | 0.92 | 1.00 | 0.83 | 1.00 | 56.0 | 12.0 | $0.0503 | 9544 / 41779 | 189.4 | 0 |
| R | 0.98 | 0.62 | 1.00 | n/a | 0.00 | 1.00 | 89.0 | 0.0 | $0.0968 | 27033 / 76165 | 371.9 | 0 |

- B run 1: missed requirements R47, R52; missed sections 1; ambiguities not raised A8, A9; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements R53; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 24; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 60 labelled requirements in 16 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0514 | 10046 / 42666 | 197.7 | 1 |
| R | 1.00 | 0.54 | 1.00 | n/a | 0.00 | 1.00 | 112.0 | 0.0 | $0.0930 | 27594 / 72171 | 358.3 | 0 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 41; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0515 | 14988 / 42666 | 180.2 | 1 |
| R | 1.00 | 0.52 | 1.00 | n/a | 0.00 | 1.00 | 204.0 | 0.0 | $0.1427 | 39000 / 111584 | 543.0 | 0 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 66; judge invalid 0, ungraded 0.

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31270 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0553 | 26438 / 42666 | 195.1 | 1 |
| R | 1.00 | 0.55 | 1.00 | n/a | 0.00 | 1.00 | 392.0 | 0.0 | $0.1966 | 70886 / 150495 | 718.6 | 0 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 136; judge invalid 0, ungraded 0.

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/deepseek-flash |

### R — the document reader (readDocument): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| reader | readDocument (document-reader/reader.ts), mode chosen by the model's window |
| requirements | statements labelled requirement, constraint or business-rule |
| questions | none (Phase 2) |
| model | anthropic/deepseek-flash |
