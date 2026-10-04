---
name: citation-shapes
description: Analysis findings carry two citation shapes; resolve code citations against CodeSymbol by project, never trust a document filename.
metadata:
  type: project
---

Analysis findings carry two citation shapes. **Document** citations have `documentId`/`filename`, where `filename` is a retrieval document name (`connector:repo:<id>:src/<rel>`, an upload, `Live database schema`, a man page). **Code** citations have `filePath`/`startLine`/`endLine`/`symbolId`. #768 found `seed-code-links-from-findings.ts` storing document filenames as "direct code links".

**Why:** a document name is not code; storing it as a code link fakes traceability.

**How to apply:** anything that treats citations as code must resolve them against `CodeSymbol` filtered by `projectId` (symbol id, enclosing symbol, or a repo key stripped with `extractRepoRelPath`), and drop the rest.
