# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$80** · Spent: **$3.8004** (judge $0.7447)

Commit: 2d78fb104ca78d325a149fb0e7d857d9c325bbed

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 [0.97–1.00] | 0.95 [0.92–0.97] | 1.00 | n/a | 0.00 | 1.00 | 116.6 | 0.0 | $0.3243 | 107827 / 26046 | 137.4 | 0 |
| B | 0.90 [0.86–0.94] | 1.00 [0.98–1.00] | 0.97 [0.94–1.00] | 1.00 | 0.67 [0.44–0.83] | 1.00 | 55.3 | 13.0 | $0.1153 | 7201 / 10094 | 56.3 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17991 bytes of Word; 26 sections, 26 chunks; 59 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.97 [0.97–0.98] | 0.97 [0.97–0.97] | 1.00 | n/a | 0.00 | 1.00 | 59.5 | 0.0 | $0.2051 | 35530 / 17552 | 92.8 | 0 |
| B | 0.86 | 0.99 [0.98–1.00] | 1.00 | 1.00 | 0.83 | 1.00 | 51.5 | 12.5 | $0.1041 | 7010 / 9009 | 50.1 | 0 |

- R run 1: missed requirements R51, R54; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements R51; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R51, R57, R53, R54, R55, R58, R56, R59; missed sections 0; ambiguities not raised A9, A12; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R51, R57, R52, R53, R54, R55, R58, R59; missed sections 0; ambiguities not raised A9, A12; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 63 labelled requirements in 17 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 | 0.97 | 1.00 | n/a | 0.00 | 1.00 | 65.0 | 0.0 | $0.2143 | 49455 / 18074 | 97.0 | 0 |
| B | 0.94 | 1.00 | 0.94 | 1.00 | 0.50 [0.44–0.56] | 1.00 | 59.0 | 13.5 | $0.1266 | 7392 / 11179 | 62.4 | 0 |

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 1; judge invalid 0, ungraded 0.

- B run 1: missed requirements R61, R62, R60, R63; missed sections 1; ambiguities not raised A7, A9, A10, A12, A13, A15, A16, A18; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R61, R62, R60, R63; missed sections 1; ambiguities not raised A7, A9, A10, A12, A13, A14, A15, A16, A17, A18; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 [0.98–0.99] | 0.96 [0.95–0.97] | 1.00 | n/a | 0.00 | 1.00 | 108.5 | 0.0 | $0.2779 | 83044 / 22934 | 119.1 | 0 |
| B | not run | | | | | | | | | | | |

- R run 1: missed requirements R105; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 0; judge invalid 0, ungraded 0.

- R run 1: missed requirements R103, R105; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 1; judge invalid 0, ungraded 0.

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31269 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 [0.99–1.00] | 0.92 [0.92–0.92] | 1.00 | n/a | 0.00 | 1.00 | 233.5 | 0.0 | $0.5999 | 263281 / 45625 | 240.7 | 0 |
| B | not run | | | | | | | | | | | |

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 8; judge invalid 0, ungraded 0.

- R run 1: missed requirements R37, R216; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 7; judge invalid 0, ungraded 0.

## Arms

### R — the document reader (readDocument): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (docxToMarkdown) |
| reader | readDocument (document-reader/reader.ts), mode chosen by the model's window |
| requirements | statements labelled requirement, constraint or business-rule |
| questions | none (Phase 2) |
| model | anthropic/claude-sonnet-5-5 |

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |
