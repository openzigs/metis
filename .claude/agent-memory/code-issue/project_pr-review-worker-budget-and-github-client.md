---
name: pr-review-worker-budget-and-github-client
description: Automatic PR review — budget semantics (limit <= 0 is no cap, null cost), per-PR state races, enqueue sites missing context, end-to-end test recipe, and the GitHub client traps (@octokit/request ignores agent/timeout; GHE base URL; same-origin redirects only) (#1467, #1473, #1474).
metadata:
  type: project
---

From #1467, #1473, #1474 and their reviews (2026-10-23/24). Code: `server/src/lib/agents/pr-reviewer/`.

**Budget.**
- `checkBudget` / `budget-guard.ts` treats `prReviewMonthlyBudgetCents <= 0` as no cap, so the
  schema rejects 0 (min 1) deliberately. Any "is a limit set?" check must use `capCents > 0`,
  not `!= null`.
- Spend rows for unpriced models have null cost, and `sumPrReviewSpendCents` used to count
  null as $0, so the cap bound only priced models (fixed in #1474). Pricing traps:
  [[ai-usage-metering-and-caching]].
- Review heuristic: look for per-project settings a guard reads but nothing writes
  (`autoReviewPrs` and the budget column had no writer until #1467). Grep for a writer of
  every column a gate reads.

**State and enqueue sites (#1473 review).**
- Adding a state write to a once-silent path exposes old bugs: the manual re-review route
  queued jobs with no `prBody` / `branchName`, so every re-run resolved as `no_linked_issue`.
  Check what each enqueue site puts in the job context.
- The queue runs up to 2 jobs per repo at once (`concurrencyPerRepo`), so per-PR state written
  from the job path is last-writer-wins unless ordered.

**Testing.**
- End to end with no model: the real `startWorker`, a stub judge and Octokit, a recording
  queue, and a published issue whose draft has `## Acceptance criteria`.
- A webhook on/off test asserting only "nothing enqueued" passes on unfixed code. Each off
  case must switch on, confirm it fires, then switch off, in the same test.
- `idSchema` requires ids of at least 10 chars, so `PATCH /api/projects/:id` 400s for short
  test project ids.

**GitHub client (#1474).**
- `@octokit/request` >= 10 ignores `request.agent` and `request.timeout` and follows redirects
  by default. An Octokit "pinned" via an `https.Agent` is not pinned and has no timeout. Use
  the undici-dispatcher pattern (`lib/connectors/repo/repo-service.ts`, `resolveConnectorDispatcher`;
  `publishing/octokit-factory.ts` since #1471) and test the real factory.
- A GHE `RepoConnection.apiBaseUrl` is stored as typed (bare host or browse URL). Every GitHub
  client builder must rewrite it to `{origin}/api/v3` as `acquireOctokit` does
  (`githubApiBaseUrl` in `production-deps.ts`).
- GitHub answers a renamed or transferred repo/issue with a same-host 301/307, and publisher
  reconcile depends on following it. Never `redirect: "error"`; refuse only cross-origin
  redirects (`buildPublishFetch`). Probe a hand-rolled redirect follower for cross-port and
  cross-scheme hops and the 303 POST-to-GET switch; shipped tests usually cover only
  cross-host, same-host 301 and a loop, so an origin check weakened to hostname goes unseen.
- CodeQL fails any test setting `NODE_TLS_REJECT_UNAUTHORIZED=0`. For a loopback HTTPS stub,
  generate a cert with a SAN via openssl and trust it with `tls.setDefaultCACertificates`.

**Errors, retries and spend (#1485, #1487 and reviews, 2026-10-24).**
- `@octokit/request` >= 10 wraps anything a custom `request.fetch` throws in
  `RequestError(500)`, with the original on `.cause`. Typed errors from `buildPublishFetch`
  must be unwrapped in the `defaultOctokit` request wrapper, or every caller sees a GitHub "500".
- `PublishError.retryable` defaults to false and nothing sets it true, so a `retryable`-based
  gate really means "any PublishError". Gate retry loops on `isRedirectRefusal()`
  (`publishing/types.ts`), never on `!retryable`.
- `executePrReviewJob` must never throw after `runPrReview` has run: the queue retries any
  processor throw, re-running the model and re-posting. It swallows every `runPrReview` error,
  so claims that the queue retries the model on a judge or post failure are usually false:
  trace the error to the queue first.
- Spend is recorded in `runPrReview` right after `judge.evaluate`; never add a second
  `budget.record` on the success path. `computeRunCost` matches `TokenUsage` rows by the run's
  exact `sessionId` within its window, so every spend writer must record under the run's own
  `sessionId`. It and `recordPrReviewSpend` once keyed on different ids, so every run's cost
  read 0, hidden because every pr-review test mocked `computeRunCost`: test ledger write and
  read under the same session, unmocked.
- A best-effort wrapper written `fn().catch()` misses synchronous throws. Use
  `Promise.resolve().then(fn).catch()`, and never `(err as Error).message`.

**Panel trigger gap.** `shouldRunAdversarialPass` returned `required: false` for
`production-deps.ts`, which reads vault secrets (`readBoundSecret`) and builds an outbound
GitHub client: its path rules miss credential reads outside auth/secrets dirs. Run the panel
by judgement there.

Related: [[publishing-guards-repo-identity-limiters]], [[same-origin-href-check]],
[[test-falsifiability-traps]].
