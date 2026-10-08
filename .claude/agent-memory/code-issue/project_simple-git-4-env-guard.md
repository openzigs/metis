---
name: project_simple-git-4-env-guard
description: simple-git 4 throws on guarded env keys passed via .env() unless in allowEnvironment, and silently drops inherited ones
metadata:
  type: project
---

simple-git 4 (PR #906, #903) guards every `GIT_*` key plus `EDITOR`, `PAGER`, `PREFIX`, `VISUAL`, `SSH_ASKPASS`. A guarded key passed through `.env()` throws unless listed in `allowEnvironment` (see `SIMPLE_GIT_ALLOWED_ENV` in `server/src/lib/connectors/repo/repo-service.ts`); a guarded key inherited from the server env is silently deleted. `PATH`, `HOME`, `*_PROXY` are not guarded.

**Why:** the upgrade broke authenticated clones while every fake-git test stayed green.

**How to apply:** any new git env key needs a real-git test (`server/tests/repo-service-simple-git-real.test.ts`); tests using `__setSimpleGitFactory` cannot catch the guard.
