---
issue: 2280
section: Added
---

- With `ANALYSIS_DOCUMENT_READER` on, a document the model has read is not paid for twice. Its reading is saved, and the next Requirements Analysis or Impact Analysis of the same file, read by the same reader and model, reuses it with no model call. Changing the file, the model, the reader version, or the text read (for example after image descriptions are added) reads it again. A failed, partial or empty reading is never saved, and pasted text is not saved.
- The run says when it reused a reading, with the date and model it was read with: the Requirements Analysis coverage panel and document summary, and the impact run's summary.
- "Read the documents again" on the Requirements Analysis start form, "Read the document again" on a new impact analysis from a document, and "Re-run, reading the document again" on an impact analysis each read the document afresh and replace the saved reading. Regenerating the document agent also reads it again.
- Deleting a document deletes its saved readings. A reading is only reused within the document's own project, after the run has checked that the user can read the document.
