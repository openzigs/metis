---
issue: 2255
section: Changed
---

- Requirements Analysis now reads each selected document in full by default (`ANALYSIS_DOCUMENT_READER` is on). Impact Analysis and portfolio checks, which share the setting, read a document source with the model too. An administrator can set it to false to go back to ten retrieved chunks.
- Re-measured on Sonnet 5.5, the reader finds the requirements a whole-document read finds, at precision within 0.05 of it (0.96 to 0.98 against 1.00), and also reads the 60 KB document that read cannot finish. Results: `docs/DOCUMENT_UNDERSTANDING_BASELINE.md`.
