---
issue: 2235
section: Changed
---

- Clarifying questions now say what kind of question they are: something the project's documents or code may already answer (METIS searches for it first), a passage that can be read more than one way, or something the document does not say. Each question offers the possible answers as buttons that fill in the answer box.
- METIS asks only the questions whose answer would change what gets built, highest impact first, and at most 8 a round. A question nobody can answer yet is listed as an open item, and a question whose readings would all build the same thing is listed as not asked. The panel says when more questions are waiting for the next round.
- With the document reader on (`ANALYSIS_DOCUMENT_READER`), questions are written from the uploaded document's own words. Each one quotes the paragraph it is about under its section heading. Vague terms ("fast", "user-friendly"), escape clauses ("where possible"), open-ended lists ("etc.") and "TBD" placeholders in that paragraph are flagged before the model is asked.
