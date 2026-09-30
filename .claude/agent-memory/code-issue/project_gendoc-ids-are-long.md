---
name: gendoc-ids-are-long
description: Not every Document id is a cuid: generated docs use ~94-char gendoc- ids
metadata:
  type: project
---

Generated-doc publication writes `gendoc-…` Document ids of about 94 characters. PR #469 capped a cursor's id at 64 characters, which broke paging through generated docs; the adversarial panel caught it.

**Why:** Any cap on a document id — in a cursor, schema, path or log field — must fit gendoc- ids.

**How to apply:** Before capping an id length, grep `generatedDocSyntheticDocumentId` and size the cap for its output.
