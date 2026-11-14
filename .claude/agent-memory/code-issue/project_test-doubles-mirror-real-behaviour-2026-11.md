---
name: test-doubles-mirror-real-behaviour-2026-11
description: Test setup traps — the mock developer role lacks project.create, and a stubbed orchestrator must copy its forwarding behaviour.
metadata:
  type: project
---

From code-review on 2026-11-12/13.

- **Mock `developer` lacks `project.create`.** A test that creates a project must authenticate as `coordinator`, or it 403s for a reason unrelated to the code under test ([[permission-mock-hides-removed-gate]]).
- **A server test that stubs the orchestrator must copy what it forwards.** A stub that swallows its arguments or drops the forwarded fields passes while the real call would lose them. Copy the real forwarding behaviour into the stub, then assert on what reached it ([[whole-module-vi-mock-stubs-500-at-runtime]]).
- **Orchestrator pipeline suites hand-mock each prisma method** (24 of them mock only `repoConnection.findMany`). Switching a pipeline-reached read to another method (say `findFirst`) breaks them all, so grep the model in `server/src` and `server/tests` first (#2458; same shape as [[createbatch-repoconnection-query-breaks-five-mocks]]).
- **A limiter whose `acquire()` resolves a microtask later lets several admitted calls run after one aborts.** Re-check the signal after acquiring. After changing the portfolio gap engine, run every `server/tests/portfolio-*.sqlite.test.ts` (#2476).
