---
name: product-repo-access-traps
description: Traps when gating or hiding cross-workspace rows on products — new-writes-only fixes, echoing responses, per-product artifacts (#1250, #1258, #1261)
metadata:
  type: project
---

Learned on PRs #1257, #1260 and #1262 (products: a member could attach, then read, another workspace's repo connection).

- **A foreign-id access fix gates new writes only.** Rows written while the hole was open are still read unchecked by later consumers (`/analyze`, `GET`). Ask whether the joined row's readers re-check access, and whether existing rows need a read-only audit (`pnpm audit:product-repos`, #1258).
- **Hiding a row from readers must cover mutation responses that echo it.** `PATCH /api/products/:id` returned every hidden repo's full `RepoConnection` via `updateProduct`'s include. It must also cover stored outputs derived from the row: product docs and edge evidence. The panel caught both after self-review missed them.
- **Product documents are stored per product, not per caller.** A per-caller narrowing of `/analyze` must narrow its `deleteMany` too, or one member's run deletes docs other readers can see. It also rewrites *every* artifact built from the filtered input (neighbours' per-service docs, not only the unified doc), so mark them partial (#1261).
- **Read a generator's inputs before naming artifact types in a brief.** An api-contract doc is built from its own repo's specs alone, so marking it partial was wrong. The dispatch over-specified it (#1262).
- **`server/src/routes/products-multi.test.ts` mocks `product-service` with an explicit export list.** A new named export there makes `/analyze` 500 until the mock gains it.

Related: [[membership-access-widening-checklist]], [[object-acl-side-channels]], [[test-falsifiability-traps]].
