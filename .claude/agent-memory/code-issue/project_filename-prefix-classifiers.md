---
name: filename-prefix-classifiers
description: Document classification by filename prefix is a trust boundary
metadata:
  type: project
---

Readers classify documents by filename prefixes (connector:, repo:, jira:, confluence:, generated-doc-, live-schema:). #516 moved one reader to documents.source, which let a connector-shaped upload persist beside the real row and still fool the others; #540 then reserved the prefixes on upload.

**Why:** Moving one reader to source does not protect the rest; the UI matches prefixes too.

**How to apply:** When touching classification, grep server readers AND ui/src/lib/format-source-label.ts and doc-label.ts; match each prefix with the same case rule its readers use (#540).
