---
name: project_structured-req-ids-repeat
description: Model-assigned structured requirement ids (REQ-001) repeat across re-syntheses — scope any promoted-id record to the run
metadata:
  type: project
---

Structured requirement ids are assigned by the model (`REQ-001`, see `server/src/lib/analysis/prompts.ts`) and repeat across re-syntheses of the same analysis. PR #902 (#723) keyed its `promotedStructuredIds` record on them, so after a withheld re-run colliding ids look already promoted and the rest get appended beside the reviewed set.

**Why:** the id is per-synthesis output, not a stable identity.

**How to apply:** any "already promoted / already seen" record keyed by structured ids must be scoped to the synthesis run (or keyed by content hash), never global per analysis.
