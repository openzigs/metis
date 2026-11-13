---
issue: 2296
section: Fixed
---

- A vague term in a document statement no requirement cites is no longer attached to an unrelated requirement on filler words such as "the", "system" and "shall": only the words that say what a requirement is about count toward the match.
- A clarifying question raised on a paragraph now always cites that paragraph, also when its requirement already rests on five others. A requirement keeps at most ten source paragraphs, those with a flagged term first, so its question prompt stays bounded.
- The clarify API decides how questions are asked from the analysis's stored requirements, not from a requirements list the caller sends.
- An analysis now asks its clarifying questions in the way it was read in, every round: the classified questions when the document reader read its requirements, the earlier questions otherwise. Turning `ANALYSIS_DOCUMENT_READER` on or off partway through a clarification no longer mixes the two. With the reader off, questions no longer offer suggested readings, and a re-asked question request no longer asks the model for the reader's fields.
