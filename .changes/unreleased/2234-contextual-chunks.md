---
issue: 2234
section: Added
---

- Contextual chunks, behind `RAG_CONTEXTUAL_CHUNKS` (off by default). With
  `headings`, each document chunk is indexed for search together with its
  document's title and lead sentence and the chunk's heading path, so a passage
  such as "the system shall notify them" can be found by the section it sits in.
  With `model`, the project's AI model also writes one sentence placing each chunk
  in its document, reading the document once from the prompt cache. The text a
  search shows is unchanged. Measured on the document-retrieval corpora, neither
  mode gave an established improvement, so both stay off until a corpus shows one.
