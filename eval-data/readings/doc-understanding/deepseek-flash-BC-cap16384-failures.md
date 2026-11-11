# Document understanding eval (#2229)

Model: **anthropic/deepseek-flash** · Judge: **anthropic/deepseek-flash** · Runs requested: **1** · Budget: **$3** · Spent: **$0.2307** (judge $0.0000)

Commit: 8a0601902972f33ebde129dce9a15d7e467e01c2

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0406 | 11384 / 32768 | 168.6 | 3 |
| C | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.1088 | 53362 / 83929 | 267.6 | 1 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 102 labelled requirements in 30 sections, 14 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0415 | 14562 / 32768 | 169.6 | 1 |
| C | not run | | | | | | | | | | | |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (empty-response)

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17994 bytes of Word; 26 sections, 26 chunks; 46 labelled requirements in 12 sections, 11 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0395 | 9544 / 32768 | 169.5 | 1 |
| C | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.1088 | 53362 / 83929 | 267.6 | 1 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (empty-response)

- C run 1: **failed** — reader: doc-understanding-reduce: no usable reply (empty-response)

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 58 labelled requirements in 16 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.0408 | 10046 / 32768 | 166.6 | 1 |
| C | not run | | | | | | | | | | | |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (empty-response)

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/deepseek-flash |

### C — section by section with a document summary, glossary and actors, then a reduce

| Setting | Value |
|---|---|
| conversion | parseDocument (mammoth + htmlToMarkdown) |
| context | one call over the whole document: summary, glossary, actors |
| sections | splitSections (governing/rule-extraction.ts): every heading, long sections split |
| reduce | one call: drop repeated requirements, settle and add cross-section questions |
| model | anthropic/deepseek-flash |
