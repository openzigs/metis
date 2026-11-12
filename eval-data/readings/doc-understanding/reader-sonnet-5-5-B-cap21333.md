# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$4** · Spent: **$0.7996** (judge $0.0688)

Commit: 658a61dc26c145a31cdfed08485489713cc16c41

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1.00 | 1.00 | 1.00 | 0.83 | 0.59 | 1.00 | 106.0 | 18.0 | $0.3654 | 24203 / 31699 | 173.1 | 1 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## By document

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 1.00 | 1.00 | 1.00 | 0.83 | 0.59 | 1.00 | 106.0 | 18.0 | $0.2287 | 10687 / 20732 | 116.9 | 0 |

- B run 1: missed requirements none; missed sections 0; ambiguities not raised A4, A5, A8, A9, A10, A12, A13; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31270 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.5021 | 37718 / 42666 | 229.4 | 1 |

- B run 1: **failed** — reader: doc-understanding-whole: no usable reply (unparseable)

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |
