---
issue: 2255
section: Changed
---

- The document reader (`ANALYSIS_DOCUMENT_READER`) was measured on the four document-understanding corpora on Sonnet 5.5 and DeepSeek. It finds every requirement, including on the 60 KB document a one-reply read cannot finish, but repeats many of them (precision 0.59 to 0.69 against 1.00), so it stays off by default. Results: `docs/DOCUMENT_UNDERSTANDING_BASELINE.md`.
- The corpora's labels were cross-checked by two blind AI reviewers, with each disagreement judged by an AI and confirmed by a person: 18 requirements and 12 ambiguities added, five ambiguities re-kinded.
