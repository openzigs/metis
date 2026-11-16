---
issue: 2255
section: Changed
---

- Requirements Analysis now reads each selected document in full by default (`ANALYSIS_DOCUMENT_READER` is on), and Impact Analysis and portfolio checks read a document source with the model, as the same setting has them do. Re-measured on Sonnet 5.5, the reader finds the requirements a whole-document read finds, with precision within 0.05 of it (0.96 to 0.98 against 1.00) on every document that read could answer, and it also reads the 60 KB document that read cannot finish. An administrator can set it to false to go back to ten retrieved chunks. Results: `docs/DOCUMENT_UNDERSTANDING_BASELINE.md`.
