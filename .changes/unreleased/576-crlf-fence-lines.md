---
issue: 576
section: Fixed
---

- The document viewer no longer treats the rest of a document as code after a
  code fence closed on a Windows (CRLF) line ending. In a document mixing line
  endings, a fence, heading or reference-definition line ending in CRLF now
  splits sections and resolves links exactly as the whole document renders.
