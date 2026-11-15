# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$30** · Spent: **$2.8579** (judge $0.1488) · Output cap: **16384**

Commit: 1f9a591fbf36e944d3e17e8c5720005fddf8c539

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.98 [0.95–1.00] | 0.97 [0.95–0.98] | 0.97 [0.92–1.00] | 0.67 [0.38–0.88] | 0.07 [0.00–0.12] | 1.00 | 77.0 | 8.0 | $0.9030 | 81798 / 83337 | 332.9 | 0 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the arm's alone; the judge's spend is reported apart. Arm R's also includes the extraction and the question call of its question round (#2271), so its $ / doc, tokens and s / doc are not comparable with R readings made before #2271, which were the reader's alone.

## Questions

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 24 | 3 of 47 | 0 | 2 | 46 |

Totals over the scored readings whose question round ran; "failed" means no reading had one (the reading, its judge or the round failed), and a count of failed rounds follows the questions asked where only some did. A labelled ambiguity is found when the judge matches a question asked to it; each counts once per reading. Set aside and over the cap are counted where an arm selects what it asks (R, #2235): it sets aside a question no one can answer yet (unanswerable) or whose readings all build the same thing (same outcome), and asks at most 8 a round, leaving the rest for the next. Arms A, B and C ask every question they raise, so theirs read n/a.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17991 bytes of Word; 26 sections, 26 chunks; 59 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.95 | 0.97 | 0.92 | 0.38 | 0.08 | 1.00 | 58.0 | 8.0 | $0.6778 | 56470 / 62692 | 272.3 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 8 | 1 of 12 | 0 | 0 | 16 |

- R run 1: missed requirements R47, R51, R54; missed sections 1; ambiguities not raised A1, A2, A3, A4, A6, A7, A8, A9, A10, A11, A12; repeats 0; judge invalid 0, ungraded 0.

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 63 labelled requirements in 17 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 1.00 | 0.95 | 1.00 | 0.75 | 0.00 | 1.00 | 66.0 | 8.0 | $0.8118 | 74655 / 74871 | 286.0 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 8 | 0 of 18 | 0 | 1 | 15 |

- R run 1: missed requirements none; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12, A13, A14, A15, A16, A17, A18; repeats 1; judge invalid 0, ungraded 0.

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | 0.99 | 0.98 | 1.00 | 0.88 | 0.12 | 1.00 | 107.0 | 8.0 | $1.2195 | 114268 / 112447 | 440.4 | 0 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 8 | 2 of 17 | 0 | 1 | 15 |

- R run 1: missed requirements R103; missed sections 0; ambiguities not raised A1, A2, A3, A4, A5, A6, A7, A8, A10, A11, A12, A13, A14, A16, A17; repeats 1; judge invalid 0, ungraded 0.

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
