---
issue: 2374
section: Changed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`, still off by default), fewer of the statements it lists as requirements are not requirements. A sentence that only introduces the list or table after it, or that gives the reason for another requirement, is now read as background. A summary table's rows that each repeat part of one sentence in the body, and say nothing that sentence does not, are now dropped as repeats, where before both were kept.
- With the document reader on, each part of a long document is read without also writing out the parts after it. On the 60 KB measurement document that had produced about 20 statements a run that were thrown away and paid for twice.
- Requirement precision on the four measurement documents (Sonnet 5.5, two runs) is now 0.97, 0.97, 0.96 and 0.92. On the first two documents, six of the reader's extra requirements were judged by an AI, not yet confirmed by a person, to be missing from the answer key, and were added to it.
- Documents read before this change are read again the next time they are analysed.
