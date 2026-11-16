---
issue: 2255
section: Changed
---

- The document reader (`ANALYSIS_DOCUMENT_READER`) stays off by default: an administrator sets it to true to have Requirements Analysis read each selected document in full. Impact Analysis and portfolio checks share the setting.
- Re-measured on Sonnet 5.5 only (DeepSeek and other models were not re-run), it finds the requirements a whole-document read finds (recall 0.97 to 1.00 against 0.86 to 0.94, precision 0.96 to 0.98 against 1.00) and reads the 60 KB document that read cannot finish. It costs about $0.66 to $1.12 and 3.5 to 7 minutes a document, against $0.10 to $0.19 and 1 to 1.5 minutes. Results: `docs/DOCUMENT_UNDERSTANDING_BASELINE.md`.
