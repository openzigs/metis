---
issue: 2231
section: Fixed
---

- Impact Analysis on a document now reads the document itself. Before, it re-joined the document's stored search chunks, which overlap, so some passages were analysed twice and a requirement could be cut in two at a chunk boundary. If the stored file cannot be read, the chunks are joined with each overlap kept once.
- With `ANALYSIS_DOCUMENT_READER` on (off by default), Impact Analysis has the model read a document, or pasted text of 2,000 characters or more that is not a single issue, and analyses each requirement, constraint or business rule it finds as one change, instead of one change per paragraph or bullet and one per table. The run's summary says how many it found, which sections held none and which could not be read. If the reading fails, the run splits the text by paragraph as before and says so. Short pasted text and issues are still split as before.
- `IMPACT_DOCUMENT_READ_TIMEOUT_MS` (default 300000) bounds each document-reading call of an impact run.
