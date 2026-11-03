---
name: portfolio-walkthrough-fixtures
description: How to test portfolio gap/impact for real - the openzigs/metis-fixture-{orders,billing,notify} repos, their 7 ground-truth edges, and setup traps found in the 2026-11-03 two-wave ui-vision walkthrough.
metadata:
  type: project
---

**Fixtures** (public, built for this): `openzigs/metis-fixture-orders` (Orders API, writes `orders`/`customers`, publishes `order.created`), `-billing` (spec names orders, reads both tables, subscribes, writes `invoices`, publishes `invoice.issued`), `-notify` (subscribes, reads `invoices`). TypeScript only; nothing under `test/`/`fixtures/` dirs, which the crawler skips.

**Ground truth:** all three in ONE product → exactly 7 detected edges: API (spec ref), 2 topics, 3 tables, plus a shared type that points the wrong way (#1727). Check offline first: `readCloneRepoFiles` → `crawlFiles` → `detectRelationships` via `tsx` on a dir with `.git/HEAD`.

**Since #1724 (PR #1730):**
- One repo per product works. Products in the same workspace detect, declare and share edges across products. Each product stores only the edges it analysed, so run Generate Documentation on every product. Verified in the real app (wave 3).
- The UI sends no `hostProductId` (#1725). A requirement nothing covers shows "No product needs to change". POST `/api/portfolio-assessments` with `{statement, scope:"all-accessible", hostProductId}` to see the walk.

**Setup traps:**
- Create-project uses the active workspace and cannot move later (#1728). Switch the breadcrumb first.
- Only the primary connector auto-syncs; Sync the others before analysing (#1727).
- Product analyse is the "Generate Documentation" button. Reload before reading edges (#1727).
- `/api/products` is rate-limited to 120 / 15 min.
- A declared shortcut edge masks a multi-hop path, because the walk takes the shortest. Delete it before checking hop counts.
- The Add Repo picker lists every workspace's connectors by label. Give the copies distinct labels.
- A module reached by `GET /api/products/:id` must not import from `product-service`. `products-multi.authz.test.ts` mocks that module with an explicit export list.
- With a reasoning model, repo verdicts hit the 2,000-token cap and fail as `model-error` (#1726).
