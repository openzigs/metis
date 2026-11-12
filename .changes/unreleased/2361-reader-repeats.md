---
issue: 2361
section: Changed
---

- With the document reader on (`ANALYSIS_DOCUMENT_READER`, still off by default), a sentence that states several obligations is one requirement instead of several, and an overview that a later section states in full is no longer listed beside it.
- The reader labels scope lines, goals, overviews and notes about the document itself as background, not requirements. On the four measurement documents its requirement precision rose from 0.59–0.69 to 0.86–0.96 on Sonnet 5.5 over two runs; recall was 0.93–1.00, apart from one read of the 60 KB document that lost a batch's reply (0.84).
- In the coverage report, a section whose content was merged into a later one now says "read; what it says is set out in full in" that section, instead of "nothing extracted".
- Documents read before this change are read again the next time they are analysed.
