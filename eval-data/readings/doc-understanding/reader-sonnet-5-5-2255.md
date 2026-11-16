# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$9** · Spent: **$3.7639** (judge $0.2677) · Output cap: **16384**

Commit: 2623c200ea35f53980cbec61973c742f1b4b9eff

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.98 [0.97–1.00] | 0.97 [0.95–0.98] | 1.00 | 0.56 [0.25–0.75] | 0.10 [0.00–0.17] | 1.00 | 72.5 | 8.0 | $0.8237 | 80121 / 75103 | 323.8 | 0 |
| B | 0.87 [0.86–0.87] | 1.00 | 0.93 [0.92–0.94] | 1.00 | 0.58 [0.33–0.83] | 1.00 | 52.5 | 9.0 | $0.1006 | 7081 / 8646 | 45.9 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the arm's alone; the judge's spend is reported apart. Arm R's also includes the extraction and the question call of its question round (#2271), so its $ / doc, tokens and s / doc are not comparable with R readings made before #2271, which were the reader's alone.

## Questions

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 32 | 5 of 59 | 1 | 3 | 60 |
| B | 18 | 16 of 30 | n/a | n/a | n/a |

Totals over the scored readings whose question round ran; "failed" means no reading had one (the reading, its judge or the round failed), and a count of failed rounds follows the questions asked where only some did. A labelled ambiguity is found when the judge matches a question asked to it; each counts once per reading. Set aside and over the cap are counted where an arm selects what it asks (R, #2235): it sets aside a question no one can answer yet (unanswerable) or whose readings all build the same thing (same outcome), and asks at most 8 a round, leaving the rest for the next. Arms A, B and C ask every question they raise, so theirs read n/a.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17991 bytes of Word; 26 sections, 26 chunks; 59 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.97 [0.97–0.98] | 0.96 [0.95–0.97] | 1.00 | 0.75 | 0.17 | 1.00 | 60.0 | 8.0 | $0.7599 | 65993 / 69306 | 338.3 | 0 |
| B | 0.86 | 1.00 | 0.92 | 1.00 | 0.83 | 1.00 | 51.0 | 10.0 | $0.1040 | 6890 / 9017 | 48.1 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 16 | 4 of 24 | 0 | 2 | 30 |
| B | 10 | 10 of 12 | n/a | n/a | n/a |

- R run 1: missed requirements R54, R55; missed sections 0; ambiguities not raised A1, A3, A4, A6, A7, A8, A9, A10, A11, A12; repeats 1; judge invalid 0, ungraded 0.

- R run 1: missed requirements R51; missed sections 0; ambiguities not raised A1, A2, A3, A4, A6, A7, A8, A9, A11, A12; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R47, R51, R57, R53, R54, R55, R58, R59; missed sections 1; ambiguities not raised A9, A12; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 62 labelled requirements in 17 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 | 0.98 | 1.00 | 0.25 | 0.00 | 1.00 | 63.0 | 8.0 | $0.6597 | 73810 / 59613 | 213.1 | 0 |
| B | 0.87 | 1.00 | 0.94 | 1.00 | 0.33 | 1.00 | 54.0 | 8.0 | $0.0973 | 7272 / 8275 | 43.7 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 8 | 0 of 18 | 0 | 0 | 16 |
| B | 8 | 6 of 18 | n/a | n/a | n/a |

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 0; judge invalid 0, ungraded 0.

- B run 1: missed requirements R7, R59, R61, R27, R28, R29, R30, R63; missed sections 1; ambiguities not raised A6, A7, A8, A9, A10, A12, A13, A14, A15, A16, A17, A18; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 | 0.98 | 1.00 | 0.50 | 0.06 | 1.00 | 107.0 | 8.0 | $1.1155 | 114687 / 102186 | 405.3 | 0 |
| B | not run | | | | | | | | | | | |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 8 | 1 of 17 | 1 | 1 | 14 |
| B | not run | | | | |

- R run 1: missed requirements R103; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A16, A17; repeats 0; judge invalid 0, ungraded 0.

## Arms

### R — the document reader (readDocumentOnce): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (docxToMarkdown) |
| reader | readDocumentOnce (document-reader/reading-cache.ts) over readDocument (document-reader/reader.ts), mode chosen by the model's window |
| savedReadings | read again every run, then saved (reread) |
| requirements | statements labelled requirement, constraint or business-rule |
| extraction | RequirementsExtractor in source mode over those statements, at the provider's model as in an analysis (GtWR R7/R8/R9 and TBD rules on their paragraphs); a failure fails the question round, not the reading |
| questions | the dialog's first round: generateClarifyingQuestions in source mode, writing questions for at most 24 open ambiguities (ambiguitiesToQuestion, #2534), then selectQuestionsToAsk (unanswerable and same-outcome set aside, ranked, at most 8 asked); the open ambiguities as written when none is worth asking. The second round, once every question asked is answered, is counted in the diagnostics (secondRound*), not scored |
| questionModel | the provider's Haiku tier where it serves one, else its model (tierModelFor, as the dialog's round 1) |
| model | anthropic/claude-sonnet-5-5 |

### B — the whole document in one call

| Setting | Value |
|---|---|
| conversion | parseDocument (docx-to-markdown, #2232) |
| context | the whole converted document, fenced |
| calls | 1 (plus one re-prompt on an unreadable reply) |
| model | anthropic/claude-sonnet-5-5 |
