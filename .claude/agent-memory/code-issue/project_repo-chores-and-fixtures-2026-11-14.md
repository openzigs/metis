---
name: repo-chores-and-fixtures-2026-11-14
description: Repo chores - prettier ARCHITECTURE.md from root, gitignored images, migration backfill order, brd-before-1070 regeneration, findMentions, no bare npx (#2480-#2512).
metadata:
  type: project
---

- **Prettier** (#2480): `prettier --write` run from `server/` rewrites all of docs/ARCHITECTURE.md (~2,900 lines). Run it on that file from the repo root.
- **Images are gitignored** (#2490, `.gitignore` line 233+): committing walkthrough screenshots needs a reviewed `!path` line, or `git add` silently skips them.
- **Migration backfill** (#2502): a later migration backfilling a column added by an earlier one in the same release must have the later timestamp in both trees. Guard its JSON reads (`json_valid` on SQLite, `IS JSON ARRAY` on Postgres 16).
- **Model-default change** (#2512): moves the config and outputHash pinned in `brd-before-1070*.json`. Regenerate with `WRITE_BEFORE_1070_FIXTURE=1`; never hand-edit the model string.
- **Mentions** (#2510): parsing lives in `@metis/shared` `findMentions`. The old server regex kept a trailing dot, so end-of-sentence mentions never notified. New parsing must use it.
- **Undeclared tools** (#2496): never `npx <tool>` the repo does not declare; `npx biome` fetched an unrelated package (biome@0.3.3). Use `pnpm exec` or repo scripts.
