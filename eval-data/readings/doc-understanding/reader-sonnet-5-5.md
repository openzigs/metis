# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$20** · Spent: **$3.4455** (judge $0.4344)

Commit: 658a61dc26c145a31cdfed08485489713cc16c41

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.96 [0.91–1.00] | 1.00 | 1.00 | 0.96 [0.93–1.00] | 0.67 [0.50–0.83] | 1.00 | 55.5 | 12.0 | $0.2528 | 18580 / 21569 | 118.0 | 2 |
| R | 1.00 | 0.63 [0.59–0.69] | 1.00 | n/a | 0.00 | 1.00 | 168.5 | 0.0 | $0.4999 | 106391 / 28715 | 149.0 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 56 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.91 | 1.00 | 1.00 | 1.00 | 0.83 | 1.00 | 51.0 | 10.0 | $0.1037 | 7010 / 8964 | 49.6 | 0 |
| R | 1.00 | 0.62 | 1.00 | n/a | 0.00 | 1.00 | 90.0 | 0.0 | $0.2688 | 34768 / 19923 | 105.9 | 0 |

- B run 1: missed requirements R51, R52, R53, R54, R55; missed sections 0; ambiguities not raised A9, A12; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 16; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 60 labelled requirements in 16 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1.00 | 1.00 | 1.00 | 0.93 | 0.50 | 1.00 | 60.0 | 14.0 | $0.1325 | 7392 / 11776 | 65.4 | 0 |
| R | 1.00 | 0.59 | 1.00 | n/a | 0.00 | 1.00 | 102.0 | 0.0 | $0.2890 | 48319 / 19232 | 101.9 | 0 |

- B run 1: missed requirements none; missed sections 0; ambiguities not raised A7, A9, A10, A12, A13, A14, A15, A16, A17; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 31; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.3721 | 22194 / 32768 | 180.4 | 1 |
| R | 1.00 | 0.63 | 1.00 | n/a | 0.00 | 1.00 | 169.0 | 0.0 | $0.4261 | 82035 / 26200 | 135.4 | 0 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 53; judge invalid 0, ungraded 0.

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31270 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.4031 | 37722 / 32768 | 176.6 | 1 |
| R | 1.00 | 0.69 | 1.00 | n/a | 0.00 | 1.00 | 313.0 | 0.0 | $1.0159 | 260442 / 49506 | 252.7 | 0 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 71; judge invalid 0, ungraded 0.

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |

### R — the document reader (readDocument): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| reader | readDocument (document-reader/reader.ts), mode chosen by the model's window |
| requirements | statements labelled requirement, constraint or business-rule |
| questions | none (Phase 2) |
| model | anthropic/claude-sonnet-5-5 |
