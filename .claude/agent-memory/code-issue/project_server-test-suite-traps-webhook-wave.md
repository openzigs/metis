---
name: server-test-suite-traps-webhook-wave
description: Suite-level traps that only CI caught in the 2026-10-24 webhook/security wave — route-fixture-privilege, hand-rolled prisma doubles, repo-primary-unique-457's partial migration chain, sqlite model-failure Proxy, egress guards, prettier and pre-commit re-wraps, two UI test guards.
metadata:
  type: project
---

From #1480 to #1514 (2026-10-24). Most of these passed a touched-tests-only local run and
failed in CI.

**Guard suites a new route trips.**
- `server/tests/route-fixture-privilege.test.ts` (#1058) scans `server/src/routes/*.test.ts`
  too. A new route test that stubs `requireAuth` needs at least one non-admin `role:` literal:
  drive it as a workspace member and stub `prisma.project.findUnique`. Run the guard locally
  with the new suite (#1504).
- `ui/tests/a11y/accessible-primitives-guard.test.ts` fails on any `window.confirm`. Use
  `ConfirmDialog` from `@/components/ui/alert-dialog`; in tests click
  `within(screen.getByRole("alertdialog"))` (#1480).

**Hand-rolled prisma doubles.**
- `server/src/routes/sync.test.ts` stubs the dedup modules; a new import into `sync.ts` needs
  its own `vi.mock` there, or the Jira route tests go red (#1484).
- Once a route's DB guard fails closed, every suite whose prisma double lacks the table gets
  503s. Grep the tests posting to the route for a missing stub before pushing
  (`body-parser-inflate-1458.test.ts` showed only in CI, #1491).
- A binding-guarded `updateMany` on `repo_connections` needs the mocks in
  `connector-routes.test.ts` and `connector-repo-service.test.ts` to match every `where`
  field, or the Test silently records nothing (#1494).
- A new `repo_connections` column that `findProjectForRepo` filters on breaks 9+ suites
  seeding `status: "connected"` connectors; grep the tests reaching `/github/pr` (#1488).
- In sqlite suites that mock `../src/lib/prisma.js` with a `get prisma()` getter, fail one
  model by setting `state.db = new Proxy(db, …)` and restoring it in `finally`
  (`chat-custom-agent-real-providers.sqlite.test.ts`, #1500).
- `IDS.project` in `server/tests/helpers/agents-fixture.ts` has no workspace, so
  workspace-dependent wording reads the system-admin variant there.

**Migrated-SQLite suites.**
- A new `repo_connections` migration must join `server/tests/repo-primary-unique-457.sqlite.test.ts`'s
  `sqlite.apply(...)` list (a partial chain). Targeted local runs miss it; CI
  `server-unit (1/3)` catches it (#1488). For the `stopBefore` pattern see
  [[prisma-cross-database]].

**Proving races.** To prove a Test-vs-PATCH race end to end, run the real PATCH route from
inside the fake Octokit `repos.get` (a one-shot `duringGet` hook): pattern in
`server/tests/webhook-routing-1488.sqlite.test.ts`.

**UI absence assertions.** `queryByTestId(...)` null after waiting for unrelated text can pass
before a dependent react-query resolves. Await the mock's promise inside `act` first
(`ui/tests/project-pulls-page.test.tsx`, #1485).

**Egress guards in tests.**
- A socket-only egress guard misses network calls from a spawned `git` (a separate process),
  and a hostname-only guard flags SSRF-pinning tests that point `*.invalid` at loopback via a
  custom lookup: judge the address the lookup returns (#1512).
- An argv-based guard misses `git` reaching the network through a configured remote name
  (`git pull origin` in repo-service `syncRepo`). Guard self-tests must target TEST-NET-3
  (203.0.113.0/24), never a real host (#1514 review).

**Formatting churn.**
- `*.md` is in `.prettierignore`, so a whole-file `docs/USER_GUIDE.md` reformat from an
  editor's format-on-save can slip into a fix commit. Check `git show --stat` for docs churn
  (#1501 cycle 2). Where to run prettier: [[parallel-agents-share-scratch-and-browser]].
- The pre-commit hook runs prettier on staged files and can re-wrap test code. Re-run the
  touched tests on the committed tree before pushing (#1505).

Related: [[test-falsifiability-traps]], [[whole-module-vi-mock-stubs-500-at-runtime]],
[[deleted-project-background-firing-guard]].
