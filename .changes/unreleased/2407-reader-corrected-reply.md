---
issue: 2407
section: Fixed
---

- When a model's answer held an incomplete first draft followed by a corrected one ("Correction: the object above is incomplete…"), METIS kept the first draft. It now asks the model again for the one answer, on every step that reads a JSON answer this way, instead of keeping either silently. With the document reader on (`ANALYSIS_DOCUMENT_READER`, still off by default), this had lost whole groups of sections from a document while the coverage report called them read.
- With the document reader on, a section the model's reply says nothing about is asked for once more, and if the second reply also leaves it out the coverage report lists it as not read instead of read. A heading with no text under it is not counted.
- Documents read before this change are read again the next time they are analysed.
