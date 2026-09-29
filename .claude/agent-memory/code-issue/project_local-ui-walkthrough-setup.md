---
name: local-ui-walkthrough-setup
description: Running the METIS stack from a worktree for a browser walkthrough: mock login password, port overrides, Playwright upload root, quarantine.
metadata:
  type: project
---

Measured on the 2026-09-29 ui-vision walkthrough (commit 469ca6e):
- Mock-auth login is `admin@metis.local` / `password`, not `admin` (`server/src/lib/auth/mock-provider.ts`). `pnpm db:seed` seeds "Sample Project".
- The UI `dev` script hard-codes port 3000. For another port run `next dev --webpack -p <port>` with `METIS_API_URL` set, and pass the server `PORT`/`CORS_ORIGIN` through `--env-file`.
- Playwright MCP only uploads files from under the main checkout, so copy fixtures into the worktree first.
- Uploaded documents land in quarantine. Approve them at project Settings → Quarantine, or the Ingest stage won't count them.
- A local-directory connector under `LOCAL_SOURCE_ROOTS` seeds a project with ~85 real files quickly.

**Why:** each of these cost the walkthrough time to rediscover.

**How to apply:** use these when starting the stack from `.claude/worktrees/*` for e2e or visual QA.
