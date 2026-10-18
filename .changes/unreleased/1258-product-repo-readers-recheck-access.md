---
issue: 1258
section: Security
---

- Products: a repo attached from another workspace before the attach check existed is no longer shown to, analysed for, or served in generated documents to a member who cannot open its project; they see only a count of hidden repos. A soft-deleted repo connection can no longer be attached. `pnpm audit:product-repos` lists existing cross-workspace attachments, read-only.
