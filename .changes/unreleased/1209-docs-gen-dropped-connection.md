---
issue: 1209
section: Fixed
---

- A document section whose connection to the AI provider dropped on every try
  now says so, with the number of tries, instead of "an unrecognised error".
- After two sections in one run have dropped on every try, later sections are
  tried once and say why; the version's provenance records it.
  `DOCS_GEN_DROP_RETRY_SECTION_LIMIT` changes the number. A body timeout is no
  longer retried as a dropped connection.
