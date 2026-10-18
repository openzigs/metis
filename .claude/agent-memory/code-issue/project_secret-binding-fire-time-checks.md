---
name: secret-binding-fire-time-checks
description: Traps when a stored resource (webhook, scheduled job) resolves a vault secret at fire time — who bound it, retries, audit, guard order (#1235)
metadata:
  type: project
---

Learned on #1235 (PR #1242), which scoped a scheduled webhook's `${vault:…}` authHeader to the user who bound it.

- **`VaultService.read()` takes a secret id, not a label** (`vault-service.ts:386`). Before #1235 a `${vault:label}` reference resolved only when the "label" happened to be an id.
- **Ask who last bound it, not who authored it.** A fire-time check keyed on `createdById` alone misses a resource someone else edited later. #1235 added `ScheduledJob.webhookBinderId` / `webhookBoundAt` and refuses with `SECRET_BINDING_FORBIDDEN`, or `binding_stale` at fire time.
- **`TaskQueue.retry` replays the payload the task was enqueued with** (kept 7 days; coordinators hold `task.retry`). A fire-time check against a job must also require the task payload to match the job's *current* binding.
- **`resolveDurableRole` ignores `User.deletedAt` / `status`.** SCIM deprovisioning deletes only `source:"provider"` roles, so a deprovisioned admin with a local admin row still counts as admin in current-role checks (#305 BYOK has the same gap).
- **`audit()` is fire-and-forget and swallows failures.** An authorization decision that reads audit rows must fail closed on a missing row. Tests wait for `getAuditService().inFlight` to reach 0.
- **Guard order hides tests.** The webhook handler checks the host allow-list *before* resolving `authHeader`, so a fire-time vault test with a non-allow-listed URL passes without reaching the secret check.
- **A catch-all that maps every error to one message** hides which guard refused, so tests for earlier guards survive mutation. Pin each guard's audit reason in a unit test.
- **Every new secret-binding surface joins the #502 Rotate-anyway list** (`rotate-foreign-owner.ts`) (#1243).
- **`shouldRunAdversarialPass` fired on #1242 only via the label and the changelog filename**; scheduler secret paths match no signal (#1244). Run the panel by hand on secret work until that lands.

Related: [[object-acl-side-channels]], [[membership-access-widening-checklist]], [[test-falsifiability-traps]].
