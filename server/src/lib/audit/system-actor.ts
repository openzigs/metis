/**
 * #1518 — the actor id system-initiated work passes in place of a user id: the
 * boot permission re-check, the scheduled connector refresh and analysis
 * re-run, the publish reconcile, the replaced-secret sweep, library
 * auto-discover. No `User` row has this id, so nothing may persist it into a
 * foreign key to `users`: the audit log writes it as `actorId: null` with
 * `actorType: "system"` (`buildAuditLogData`), and (#1528) `createAnalysis`
 * writes it as `startedById: null`.
 *
 * #1528 — its own module, with no imports, so a call site can name it without
 * loading the audit service (which many suites replace with a mock that has no
 * such export). `audit-service.ts` re-exports it.
 */
export const SYSTEM_ACTOR_ID = "system";
