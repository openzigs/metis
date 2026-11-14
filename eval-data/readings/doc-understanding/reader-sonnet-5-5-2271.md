# Document understanding eval (#2229)

Model: **anthropic/claude-sonnet-5-5** · Judge: **anthropic/claude-sonnet-5-5** · Runs requested: **1** · Budget: **$13** · Spent: **$2.8310** (judge $0.0000) · Output cap: **16384**

Commit: a7ad8202f93dfb9e4a9937ba85ff301abc1098b0

## Results (mean over documents and runs; [min–max] where they differ)

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.7078 | 142066 / 55849 | 322.8 | 4 |

Requirement recall and precision, section coverage and ambiguity recall are computed in code from the judge's matching of each extracted requirement to a labelled one and each question to a labelled ambiguity. Question precision is the judge's verdict of "worth asking". Quote accuracy is deterministic: requirement quotes found verbatim (whitespace aside) in the converted document; arm A gives no quotes. The cost per document is the reader's alone; the judge's spend is reported apart.

## Questions

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 0 | 0 of 0 | n/a | n/a | n/a |

Totals over the scored readings. A labelled ambiguity is found when the judge matches a question asked to it; each counts once per reading. Set aside and over the cap are counted where an arm selects what it asks (R, #2235): it sets aside a question no one can answer yet (unanswerable) or whose readings all build the same thing (same outcome), and asks at most 8 a round, leaving the rest for the next. Arms A, B and C ask every question they raise, so theirs read n/a.

## By document

### docunderstanding-01-clinic-booking — Riverside Community Clinics: Online Appointment Booking, Functional Requirements Document

22129 characters converted from 17991 bytes of Word; 26 sections, 26 chunks; 59 labelled requirements in 13 sections, 12 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.5640 | 56930 / 47972 | 281.0 | 1 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 0 | 0 of 0 | n/a | n/a | n/a |

- R run 1: **failed** — reader: Structured requirements extraction failed (unparseable): Expected ',' or ']' after array element in JSON at position 39710 (line 37 column 979)

### docunderstanding-02-freight-claims — Northgate Freight: Cargo Loss and Damage Claims Handling, Business Requirements Document

23478 characters converted from 17918 bytes of Word; 36 sections, 36 chunks; 63 labelled requirements in 17 sections, 18 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.5801 | 73775 / 48695 | 277.5 | 1 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 0 | 0 of 0 | n/a | n/a | n/a |

- R run 1: **failed** — reader: Structured requirements extraction failed (unparseable): Expected ',' or ']' after array element in JSON at position 44674 (line 52 column 1095)

### docunderstanding-03-community-grants — Harbour City Council: Community Grants Management System, Functional Requirements Document

35075 characters converted from 21643 bytes of Word; 53 sections, 54 chunks; 106 labelled requirements in 31 sections, 17 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $0.6800 | 120694 / 54049 | 324.4 | 1 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 0 | 0 of 0 | n/a | n/a | n/a |

- R run 1: **failed** — reader: Structured requirements extraction failed (unparseable): Unexpected token ''', ..."cription":'Whether ""... is not valid JSON

### docunderstanding-04-library-lending — Kestrel Vale Libraries: Membership and Lending Platform, Functional Requirements Document

60624 characters converted from 31269 bytes of Word; 81 sections, 82 chunks; 216 labelled requirements in 45 sections, 30 labelled ambiguities.

| Arm | Requirement recall | Requirement precision | Section coverage | Question precision | Ambiguity recall | Quote accuracy | Requirements / doc | Questions / doc | $ / doc | Tokens in / out per doc | s / doc | Failures |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| R | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | $1.0069 | 316865 / 72679 | 408.0 | 1 |

| Arm | Questions asked | Labelled ambiguities found | Set aside: unanswerable | Set aside: same outcome | Over the cap |
|---|---|---|---|---|---|
| R | 0 | 0 of 0 | n/a | n/a | n/a |

- R run 1: **failed** — reader: Structured requirements extraction failed (unparseable): Expected ',' or ']' after array element in JSON at position 38141 (line 63 column 549)

## Arms

### R — the document reader (readDocumentOnce): whole document, statements by section batch

| Setting | Value |
|---|---|
| conversion | parseDocument (docxToMarkdown) |
| reader | readDocumentOnce (document-reader/reading-cache.ts) over readDocument (document-reader/reader.ts), mode chosen by the model's window |
| savedReadings | read again every run, then saved (reread) |
| requirements | statements labelled requirement, constraint or business-rule |
| extraction | RequirementsExtractor in source mode over those statements (GtWR R7/R8/R9 and TBD rules on their paragraphs) |
| questions | the dialog's first round: generateClarifyingQuestions in source mode, then selectQuestionsToAsk (unanswerable and same-outcome set aside, ranked, at most 8 asked); the open ambiguities as written when none is worth asking |
| questionModel | the provider's Haiku tier where it serves one, else its model (tierModelFor, as the dialog's round 1) |
| model | anthropic/claude-sonnet-5-5 |
