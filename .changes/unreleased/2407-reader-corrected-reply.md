---
issue: 2407
section: Fixed
---

- When a model's answer held an incomplete first draft followed by a corrected one ("Correction: the object above is incomplete…"), METIS kept the first draft. It now asks the model again for the one answer, on every step that reads a JSON answer this way, instead of keeping either silently.
- With the document reader on (`ANALYSIS_DOCUMENT_READER`, still off by default), that had lost whole groups of sections while the coverage report called them read. Requirement recall on the four measurement documents (Sonnet 5.5, two runs) is now 0.97, 1.00, 0.99 and 1.00, from 0.95, 1.00, 0.98 and 0.92.
- With the document reader on, a section the model's reply says nothing about is asked for once more, and if the second reply also leaves it out the coverage report lists it as not read instead of read. A heading with no text under it is not counted.
- Documents read before this change are read again the next time they are analysed.
