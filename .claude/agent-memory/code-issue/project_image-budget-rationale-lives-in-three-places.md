---
name: image-budget-rationale-lives-in-three-places
description: The server image budget rationale is stated in three places; correcting one leaves the others stale
metadata:
  type: project
---

The `metis-server` image-budget rationale is written in three places:
`docs/OPERATIONS.md` ("Container Image Sizes"), the comment on
`DEFAULT_MAX_SERVER_IMAGE_MB` in `scripts/lib/verify-image-size.mjs`, and the
gate comment in `.github/workflows/ci.yml`. PR #38 corrected the doc and left
the same false claim in both comments until a re-review caught it.

**How to apply:** before calling a docs correction done, grep the whole tree for
the old claim, not just the file that was named.

Related: `build-images.yml`'s "PR — single-arch validation" step can never run —
the workflow has no `pull_request` trigger — so tests and comments about that
step describe code that never executes.
