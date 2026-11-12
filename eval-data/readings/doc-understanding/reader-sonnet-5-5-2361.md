# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **2** · Budget: **$8** · Spent: **$3.4643** (judge $0.5575)

Commit: dcfbeedc04088d1d85a2239feabefd32cfc864e9

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 [0.95–1.00] | 0.92 [0.87–0.97] | 0.97 [0.85–1.00] | n/a | 0.00 | 1.00 | 116.9 | 0.0 | $0.3634 | 108955 / 28020 | 153.1 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 56 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.96 [0.95–0.98] | 0.92 [0.90–0.93] | 0.88 [0.85–0.92] | n/a | 0.00 | 1.00 | 59.0 | 0.0 | $0.2149 | 34350 / 17647 | 98.4 | 0 |

- R run 1: missed requirements R47; missed sections 1; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 0; judge invalid 0, ungraded 0.

- R run 2: missed requirements R45, R46, R47; missed sections 2; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 60 labelled requirements in 16 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 | 0.88 [0.87–0.90] | 1.00 | n/a | 0.00 | 1.00 | 68.0 | 0.0 | $0.2234 | 49027 / 17903 | 97.1 | 0 |

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 3; judge invalid 0, ungraded 0.

- R run 2: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 2; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 [0.98–0.99] | 0.97 [0.96–0.97] | 1.00 | n/a | 0.00 | 1.00 | 108.0 | 0.0 | $0.3494 | 90286 / 27049 | 151.2 | 0 |

- R run 1: missed requirements R105; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 1; judge invalid 0, ungraded 0.

- R run 2: missed requirements R103, R105; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31270 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 [1.00–1.00] | 0.93 [0.91–0.95] | 1.00 | n/a | 0.00 | 1.00 | 232.5 | 0.0 | $0.6657 | 262157 / 49483 | 265.7 | 0 |

- R run 1: missed requirements R37; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 8; judge invalid 0, ungraded 0.

- R run 2: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18, A19, A20, A21, A22, A23, A24, A25, A26, A27, A28, A29, A30; repeats 9; judge invalid 0, ungraded 0.

## Arms

### R — the document reader (readDocument): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| reader | readDocument (document-reader/reader.ts), mode chosen by the model's window |
| requirements | statements labelled requirement, constraint or business-rule |
| questions | none (Phase 2) |
| model | anthropic/claude-sonnet-5-5 |
