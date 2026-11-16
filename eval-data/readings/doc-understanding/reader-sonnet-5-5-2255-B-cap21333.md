# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$1** · Spent: **$0.2523** (judge $0.0650) · Output cap: **21333**

Commit: 2623c200ea35f53980cbec61973c742f1b4b9eff

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.94 | 1.00 | 1.00 | 0.75 | 0.47 | 1.00 | 100.0 | 12.0 | $0.1873 | 10567 / 16619 | 89.3 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the arm's alone; the judge's spend is reported apart. Arm R's also includes the extraction and the question call of its question round (#2271), so its $ / doc, tokens and s / doc are not comparable with R readings made before #2271, which were the reader's alone.

## Questions

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| B | 12 | 8 of 17 | n/a | n/a | n/a |

Totals over the scored readings whose question round ran; "failed" means no reading had one (the reading, its judge or the round failed), and a count of failed rounds follows the questions asked where only some did. A labelled ambiguity is found when the judge matches a question asked to it; each counts once per reading. Set aside and over the cap are counted where an arm selects what it asks (R, #2235): it sets aside a question no one can answer yet (unanswerable) or whose readings all build the same thing (same outcome), and asks at most 8 a round, leaving the rest for the next. Arms A, B and C ask every question they raise, so theirs read n/a.

## By document

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| B | 0.94 | 1.00 | 1.00 | 0.75 | 0.47 | 1.00 | 100.0 | 12.0 | $0.1873 | 10567 / 16619 | 89.3 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| B | 12 | 8 of 17 | n/a | n/a | n/a |

- B run 1: missed requirements R104, R39, R40, R41, R42, R105; missed sections 0; ambiguities not raised A3, A4, A8, A9, A10, A12, A13, A16, A17; repeats 0; judge invalid 0, ungraded 0.

## Arms

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |
