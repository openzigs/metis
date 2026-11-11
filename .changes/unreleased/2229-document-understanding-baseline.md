---
issue: 2229
section: Added
---

- `pnpm --filter server eval:doc-understanding` measures how much of a Word FRD a reader finds: three labelled documents, read by today's 10-chunk document agent, by the whole document in one call, and section by section, scored on requirement recall and precision, section coverage, question precision and cost.
- The first readings are in `docs/DOCUMENT_UNDERSTANDING_BASELINE.md`: today's Requirements Analysis finds about a quarter of a document's requirements (0.26 on Sonnet 5.5); reading the whole document finds all of them.
