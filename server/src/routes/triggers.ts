/**
 * Epic #156 (#147) — Trigger routes + webhook receivers.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { patchSchemaOf, type ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { getAsyncRunner } from "../lib/async/runner.js";
import {
  verifyGenericWebhook,
  verifyGithubWebhook,
  verifySlackWebhook,
} from "../lib/async/triggers.js";
import { webhookReceiverRateLimiter } from "../middleware/webhook-receiver-rate-limit.js";
import { audit } from "../lib/audit/audit-service.js";
import {
  isProjectSoftDeleted,
  logDeletedProjectSkip,
  softDeletedProjectIds,
  type BackgroundPath,
} from "../lib/projects/deleted-project-guard.js";
import { recordDelivery, releaseDelivery } from "../lib/agents/pr-reviewer/webhook-dedup.js";
import {
  claimPayload,
  isStaleSignedTriggerEvent,
  releasePayload,
  SIGNED_TRIGGER_EVENTS,
  signedTriggerEvent,
  signedTriggerEventTime,
  UNTIMED_RECEIVER_PREFIX,
  type PayloadClaim,
} from "../lib/webhooks/payload-replay.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("triggers");

// #680 — cap the number of triggers fired per delivery so one webhook cannot
// spawn unbounded async runs (defence-in-depth beside the rate limiter).
function maxTriggerFanout(): number {
  return Math.max(1, Number(process.env.MAX_TRIGGER_FANOUT) || 50);
}

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

const SOURCE_VALUES = ["webhook", "github", "slack", "cron"] as const;

const upsertSchema = z.object({
  name: z.string().min(1).max(120),
  source: z.enum(SOURCE_VALUES),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

// #346 — `patchSchemaOf`, not `upsertSchema.partial()`: under zod 4 `.partial()`
// still fills an inner `.default()` for an absent key, so a rename wrote
// `config: {}` (dropping the signing secret) and `enabled: true` (re-enabling a
// disabled trigger). An omitted field must stay undefined so it is not written.
const patchSchema = patchSchemaOf(upsertSchema);

function parseConfig(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return raw as Record<string, unknown>;
}

/**
 * #1064 — `config` keys that must never leave the server.
 *
 * `config` is documented in the schema as `{ secret?, repo?, event?, channel?,
 * cronExpr? }` and `secret` is the HMAC key that the UNAUTHENTICATED receivers
 * below (`/:id/fire`, `/github`, `/slack`) verify deliveries against. Anyone
 * holding it can forge a signed delivery, so the admin API returns every other
 * key but never this one.
 */
const SECRET_CONFIG_KEYS: ReadonlySet<string> = new Set(["secret"]);

/** Explicit column list, so a future `Trigger` column cannot leak by default. */
const TRIGGER_SELECT = {
  id: true,
  projectId: true,
  name: true,
  source: true,
  config: true,
  enabled: true,
  lastFiredAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

type TriggerView = {
  id: string;
  projectId: string;
  name: string;
  source: string;
  config: string;
  enabled: boolean;
  lastFiredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Shape a `Trigger` row for an API response: same wire shape as before (`config`
 * stays a JSON string, which is what the settings page parses), minus the
 * signing secret. An unparseable `config` collapses to `{}` rather than being
 * echoed back verbatim.
 */
function serializeTrigger(row: TriggerView): TriggerView {
  const cfg = parseConfig(row.config);
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!SECRET_CONFIG_KEYS.has(key)) safe[key] = value;
  }
  return { ...row, config: JSON.stringify(safe) };
}

function rawBody(req: Request): string {
  // The app stashes raw body as `req.rawBody` for webhook routes (set in app.ts).
  const raw = (req as unknown as { rawBody?: string | Buffer }).rawBody;
  if (typeof raw === "string") return raw;
  if (raw instanceof Buffer) return raw.toString("utf8");
  return JSON.stringify(req.body ?? {});
}

type FireableTrigger = {
  id: string;
  projectId: string;
  config: unknown;
  source: string;
  name: string;
};

async function submitTriggerRun(
  trigger: FireableTrigger,
  payload: Record<string, unknown>,
): Promise<{ runId: string }> {
  const cfg = parseConfig(trigger.config);
  const kind = ((cfg.kind as string) || "custom") as "analysis" | "chat" | "browse" | "custom";
  const out = await getAsyncRunner().submit({
    projectId: trigger.projectId,
    kind,
    payload: { triggerId: trigger.id, source: trigger.source, name: trigger.name, ...payload },
  });
  return { runId: out.id };
}

/**
 * #1492 — `lastFiredAt` for a GitHub trigger whose run was already submitted.
 * Best effort: the run exists, so this failing must not fail the delivery and
 * give its claim back (a redelivery would then submit the run again).
 */
async function markTriggerFired(triggerId: string): Promise<void> {
  try {
    await prisma.trigger.update({ where: { id: triggerId }, data: { lastFiredAt: new Date() } });
  } catch (err) {
    log.warn("trigger.last_fired_update_failed", { triggerId, error: (err as Error).message });
  }
}

async function spawnTriggerRun(
  trigger: FireableTrigger,
  payload: Record<string, unknown>,
): Promise<{ runId: string }> {
  const out = await submitTriggerRun(trigger, payload);
  await prisma.trigger.update({
    where: { id: trigger.id },
    data: { lastFiredAt: new Date() },
  });
  return out;
}

/**
 * #1492 — the event a GitHub trigger delivery is matched as.
 *
 * - The signed body classifies (`signedTriggerEvent`): that event, whatever
 *   the unsigned `X-GitHub-Event` header says.
 * - It does not, and the header names an event the body WOULD classify as
 *   (`pull_request`, `issues`, `push`, …): `null`. The header is contradicted
 *   by the signed body, so no event-filtered trigger matches it.
 * - It does not, and the header names another event (`release`,
 *   `workflow_run`, …): the header, the only source there is. A relabelled
 *   replay of such a body still fires nothing: on the genuine delivery, every
 *   trigger whose secret verified it and whose filter did NOT match claimed
 *   it. The only unclaimed ones are matching triggers left over by the fan-out
 *   cap, which have not fired for this body and may fire once later.
 */
function deliveryEvent(signed: string | null, header: string | undefined): string | null {
  if (signed !== null) return signed;
  const claimed = (header ?? "").trim();
  if (!claimed || SIGNED_TRIGGER_EVENTS.has(claimed)) return null;
  return claimed;
}

function eventMatches(filter: unknown, event: string | null): boolean {
  return !filter || filter === event;
}

/**
 * #1438 — a sender that keeps delivering to a deleted project's trigger would
 * otherwise write one audit row per delivery. The audit is the durable record
 * that deliveries are still arriving, so one row per trigger per window says
 * that; every delivery is still logged. Bounded: the oldest entry is evicted.
 */
const SKIP_AUDIT_WINDOW_MS = 60 * 60 * 1000;
const SKIP_AUDIT_MAX_TRACKED = 10_000;
const lastSkipAuditAt = new Map<string, number>();

function shouldAuditSkip(triggerId: string, now = Date.now()): boolean {
  const last = lastSkipAuditAt.get(triggerId);
  if (last !== undefined && now - last < SKIP_AUDIT_WINDOW_MS) return false;
  lastSkipAuditAt.delete(triggerId);
  lastSkipAuditAt.set(triggerId, now);
  if (lastSkipAuditAt.size > SKIP_AUDIT_MAX_TRACKED) {
    const oldest = lastSkipAuditAt.keys().next().value;
    if (oldest !== undefined) lastSkipAuditAt.delete(oldest);
  }
  return true;
}

/** Test seam — forget which skips were audited. */
export function __resetTriggerSkipAudit(): void {
  lastSkipAuditAt.clear();
}

/**
 * #1438 — a verified delivery for a trigger of a soft-deleted project runs
 * nothing. Logged per delivery and audited at most once per trigger per hour,
 * so the owner can see deliveries still arriving for a project they deleted.
 */
function recordDeletedProjectSkip(
  path: BackgroundPath,
  trigger: { id: string; projectId: string },
): void {
  logDeletedProjectSkip({
    path,
    projectId: trigger.projectId,
    sourceType: "trigger",
    sourceId: trigger.id,
  });
  if (!shouldAuditSkip(trigger.id)) return;
  audit({
    action: "trigger.skipped_project_deleted",
    target: { type: "trigger", id: trigger.id },
    metadata: { projectId: trigger.projectId, path },
  });
}

/** #1438 — the answer to a sender whose every verified trigger belongs to a deleted project. */
function projectDeletedError(): AppError {
  return new AppError(410, "PROJECT_DELETED", "The trigger's project has been deleted");
}

/**
 * #1438 — split verified triggers into those whose project is live and those
 * whose project is soft-deleted (logged and audited here). One query per
 * delivery, whatever the fan-out.
 */
async function liveTriggers<T extends { id: string; projectId: string }>(
  path: BackgroundPath,
  verified: T[],
): Promise<{ live: T[]; skipped: number }> {
  const deleted = await softDeletedProjectIds(verified.map((t) => t.projectId));
  const live: T[] = [];
  for (const t of verified) {
    if (deleted.has(t.projectId)) recordDeletedProjectSkip(path, t);
    else live.push(t);
  }
  return { live, skipped: verified.length - live.length };
}

/**
 * #340 — a by-id trigger route acts only on a trigger of the PATH's project.
 * `requireProjectAccess()` checks `:projectId`; this binds `:id` to it, so a
 * trigger of another project answers the same 404 as an unknown id and is left
 * unchanged. Trigger rows never move between projects (neither schema carries
 * `projectId`), so the id resolved here stays in the path project.
 */
async function triggerInPathProject(req: Request): Promise<{ id: string; projectId: string }> {
  const { projectId, id } = req.params as { projectId: string; id: string };
  const where = { id: String(id), projectId: String(projectId) };
  const row = await prisma.trigger.findFirst({ where, select: { id: true } });
  if (!row) throw new AppError(404, "TRIGGER_NOT_FOUND", "Trigger not found");
  return where;
}

export function projectTriggersRouter(): Router {
  const r = Router({ mergeParams: true });

  // #1064 (epic #1051) — OWASP A01/BOLA. This router is mounted project-scoped
  // at /projects/:projectId/triggers, but every route below gated only on a
  // GLOBAL role, so `:projectId` was an unchecked, caller-supplied identifier.
  // Object-level scope runs FIRST, above every route registration, so a caller
  // who cannot reach the path project is turned away with a 404 regardless of
  // role — no existence oracle, and no handler body ever runs.
  r.use(requireAuth, requireProjectAccess());

  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = (req.params as { projectId: string }).projectId;
      const rows = await prisma.trigger.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        select: TRIGGER_SELECT,
      });
      res.json(ok({ items: rows.map(serializeTrigger) }));
    },
  );

  r.post(
    "/",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      const parsed = upsertSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const projectId = (req.params as { projectId: string }).projectId;
      actorId(req);
      const created = await prisma.trigger.create({
        data: {
          projectId,
          name: parsed.data.name,
          source: parsed.data.source,
          config: JSON.stringify(parsed.data.config),
          enabled: parsed.data.enabled,
        },
        select: TRIGGER_SELECT,
      });
      res.status(201).json(ok(serializeTrigger(created)));
    },
  );

  r.patch(
    "/:id",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const data: Record<string, unknown> = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.source !== undefined) data.source = parsed.data.source;
      if (parsed.data.enabled !== undefined) data.enabled = parsed.data.enabled;
      if (parsed.data.config !== undefined) data.config = JSON.stringify(parsed.data.config);
      const updated = await prisma.trigger.update({
        where: await triggerInPathProject(req),
        data,
        select: TRIGGER_SELECT,
      });
      res.json(ok(serializeTrigger(updated)));
    },
  );

  r.delete(
    "/:id",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response) => {
      await prisma.trigger.delete({ where: await triggerInPathProject(req) });
      res.json(ok({ ok: true }));
    },
  );

  return r;
}

export function triggersWebhookRouter(): Router {
  const r = Router();

  // #680 — throttle these UNAUTHENTICATED receivers so a flood cannot amplify DB
  // load (the /github and /slack handlers scan the trigger table per request).
  // #105 — ON EACH ROUTE, never as a path-less `r.use`: this router is mounted
  // on the shared `/webhooks` prefix, and a router-level limiter runs for every
  // request that ENTERS the router, matched or not — so `/webhooks/jira/issues`
  // was counted here and again by the sync router (half the configured budget).

  // Generic webhook fire: POST /api/triggers/:id/fire
  r.post("/:id/fire", webhookReceiverRateLimiter, async (req: Request, res: Response) => {
    const id = String(req.params.id);
    // #680 — signature-first: reject a request with no signature header BEFORE the
    // DB lookup, so an unsigned flood never touches the database.
    if (!req.header("x-metis-signature")) {
      throw new AppError(401, "BAD_SIGNATURE", "Missing x-metis-signature");
    }
    const trigger = await prisma.trigger.findUnique({ where: { id } });
    if (!trigger || !trigger.enabled) {
      throw new AppError(404, "TRIGGER_NOT_FOUND", "Trigger not found or disabled");
    }
    if (trigger.source !== "webhook") {
      throw new AppError(400, "WRONG_SOURCE", `Trigger source is ${trigger.source}`);
    }
    const cfg = parseConfig(trigger.config);
    const secret = String(cfg.secret ?? "");
    const verdict = verifyGenericWebhook(rawBody(req), secret, {
      signature: req.header("x-metis-signature") ?? undefined,
      timestamp: req.header("x-metis-timestamp") ?? undefined,
    });
    if (!verdict.ok) throw new AppError(401, "BAD_SIGNATURE", verdict.reason ?? "rejected");
    // #1438 — judged only AFTER the signature, so an unsigned caller holding a
    // trigger id learns nothing about its project; the secret holder gets 410.
    if (await isProjectSoftDeleted(trigger.projectId)) {
      recordDeletedProjectSkip("trigger.webhook", trigger);
      throw projectDeletedError();
    }
    const out = await spawnTriggerRun(trigger, {
      body: req.body,
    });
    res.status(202).json(ok(out));
  });

  // GitHub: POST /api/webhooks/github
  r.post("/github", webhookReceiverRateLimiter, async (req: Request, res: Response) => {
    const sig = req.header("x-hub-signature-256");
    const body = req.body as { repository?: { full_name?: string } };
    const repo = body?.repository?.full_name;
    if (!repo) throw new AppError(400, "BAD_PAYLOAD", "Missing repository.full_name");
    // #680 — signature-first: a genuine GitHub delivery for a secret-protected
    // trigger always carries x-hub-signature-256; reject its absence BEFORE the
    // trigger-table scan so unsigned floods cannot amplify DB load.
    if (!sig) throw new AppError(401, "BAD_SIGNATURE", "Missing x-hub-signature-256");
    // #1492 — the event is the one the SIGNED body is. The header is read only
    // for an event the body cannot be classified as (see `deliveryEvent`).
    const signedEvent = signedTriggerEvent(body);
    const event = deliveryEvent(signedEvent, req.header("x-github-event"));
    const candidates = await prisma.trigger.findMany({
      where: { source: "github", enabled: true },
    });
    const forRepo = candidates.filter((t) => parseConfig(t.config).repo === repo);
    const matched = forRepo.filter((t) => eventMatches(parseConfig(t.config).event, event));
    if (forRepo.length === 0) {
      // Always 200 — GitHub treats non-2xx as failure and retries.
      res.json(ok({ matched: 0 }));
      return;
    }
    // #1492 — every trigger of the repository whose secret signed the body,
    // whatever its event filter. When the event comes from the header, the
    // non-matching ones are claimed below too, so a replay of this body under
    // a relabelled header finds them already claimed.
    const verified = forRepo.filter((t) => {
      const cfg = parseConfig(t.config);
      const secret = String(cfg.secret ?? "");
      return verifyGithubWebhook(rawBody(req), secret, sig).ok;
    });
    if (verified.length === 0) {
      res.json(ok({ matched: matched.length, fired: [] }));
      return;
    }
    // #1438 — a trigger of a soft-deleted project never fires. When that leaves
    // nothing to fire for a verified delivery, say so with a 410.
    const { live, skipped } = await liveTriggers("trigger.github", verified);
    if (live.length === 0) throw projectDeletedError();
    // #1484 — the signed `updated_at` (a push's `pushed_at`) past the replay
    // window is a replay: refused before any database write.
    if (isStaleSignedTriggerEvent(body)) {
      res.json(ok({ matched: matched.length, fired: [], reason: "STALE_DELIVERY" }));
      return;
    }

    // Delivery-id dedup, as on the other GitHub receivers: a duplicate id is
    // GitHub's own retry; a dedup failure never blocks the delivery.
    //
    // GitHub gives one GUID to EVERY webhook subscribed to an event, and the
    // dedup table is keyed on the id alone across receivers. So the key is
    // scoped to this receiver and to the signer: the lowest id among the
    // triggers this secret verified. A trigger has one secret, so two secrets
    // never verify the same trigger. A PR-review webhook, or a second trigger
    // webhook with its own secret, therefore gets its own key for the same
    // GUID, and only a retry of THIS webhook's delivery is deduped.
    const guid = (req.header("x-github-delivery") ?? "").trim();
    const signerId = verified.map((t) => t.id).sort()[0];
    const deliveryId = guid ? `github-trigger:${signerId}:${guid}` : "";
    let deliveryRecorded = false;
    if (deliveryId) {
      try {
        const dedup = await recordDelivery({ deliveryId, eventType: signedEvent ?? "unknown" });
        if (dedup.duplicate) {
          res.json(ok({ matched: matched.length, fired: [], reason: "DUPLICATE_DELIVERY" }));
          return;
        }
        deliveryRecorded = true;
      } catch (err) {
        log.warn("trigger.github_webhook_dedup_failed", {
          deliveryId,
          error: (err as Error).message,
        });
      }
    }
    const releaseDeliveryId = async () => {
      if (deliveryRecorded) await releaseDelivery(deliveryId).catch(() => undefined);
    };

    // #1492 — the delivery id is unsigned, so claim the signed body as well,
    // once PER TRIGGER: each has its own secret (its own GitHub webhook), so
    // the same body legitimately reaches this receiver once per registration.
    // A body with no signed time is claimed under the untimed prefix, which is
    // kept 90 days instead of 7: no age check backs that claim up.
    const raw = rawBody(req);
    const receiverPrefix = signedTriggerEventTime(body) === null ? UNTIMED_RECEIVER_PREFIX : "";
    const claimOf = (t: { id: string }): PayloadClaim => ({
      receiver: `${receiverPrefix}github-trigger:${t.id}`,
      eventType: signedEvent ?? "unclassified",
      rawBody: raw,
    });
    const release = (ts: Array<{ id: string }>) =>
      Promise.allSettled(ts.map((t) => releasePayload(claimOf(t))));

    // #680 — bound the fan-out per delivery. Event-matching triggers are
    // claimed in order until `cap` of them are fresh, and those fire. The
    // rest are NOT claimed, so GitHub's "Redeliver" reaches them: each one
    // drains the next `cap` without re-running a trigger that already fired.
    //
    // Non-matching triggers are claimed only when the event came from the
    // header (`signedEvent === null`): there a replay relabelled to their
    // event would match them. A classified body's event is fixed by the
    // signature, so they can never match it and need no claim. That loop is
    // not capped, because leaving one unclaimed re-opens the relabel. It is
    // bounded by the triggers an admin created on this repository with this
    // same secret.
    const cap = maxTriggerFanout();
    const matching = live.filter((t) => eventMatches(parseConfig(t.config).event, event));
    const others = live.filter((t) => !eventMatches(parseConfig(t.config).event, event));
    const claimed: typeof live = [];
    const toFire: typeof live = [];
    let attempted = 0;
    let duplicate = 0;
    try {
      for (const t of matching) {
        if (toFire.length >= cap) break;
        attempted++;
        if ((await claimPayload(claimOf(t))).duplicate) {
          duplicate++;
        } else {
          claimed.push(t);
          toFire.push(t);
        }
      }
      if (signedEvent === null) {
        for (const t of others) {
          if ((await claimPayload(claimOf(t))).duplicate) duplicate++;
          else claimed.push(t);
        }
      }
    } catch (err) {
      // Fail CLOSED: firing without a claim is the unguarded replay. Give back
      // what this request recorded, so GitHub's "Redeliver" is processed later.
      log.warn("trigger.github_payload_claim_failed", {
        deliveryId,
        error: (err as Error).message,
      });
      await Promise.allSettled([release(claimed), releaseDeliveryId()]);
      throw new AppError(
        503,
        "REPLAY_GUARD_UNAVAILABLE",
        "The replay guard could not record this delivery",
      );
    }
    const capped = matching.length - attempted;

    const fired: string[] = [];
    for (let i = 0; i < toFire.length; i++) {
      const t = toFire[i];
      let out: { runId: string };
      try {
        // The run payload's `event` stays a string, as before #1492: the
        // matched event, or "unknown" when there is none (no header, or one
        // the signed body contradicts).
        out = await submitTriggerRun(t, { event: event ?? "unknown", body });
      } catch (err) {
        // #1492 — a failed submit created no run (one row insert). Give back
        // its claim and the claims of the triggers not yet fired, plus the
        // delivery id, so a redelivery fires exactly those. The triggers that
        // DID fire keep their claims: releasing them would run them twice.
        await Promise.allSettled([release(toFire.slice(i)), releaseDeliveryId()]);
        throw err;
      }
      fired.push(out.runId);
      await markTriggerFired(t.id);
    }
    // Triggers left over by the cap: give the delivery id back too, so the
    // sender's redelivery of this same delivery is not deduped before them.
    if (capped > 0) await releaseDeliveryId();
    res.json(
      ok({
        matched: matched.length,
        fired,
        ...(duplicate ? { duplicate } : {}),
        ...(capped ? { capped } : {}),
        ...(skipped ? { skippedDeletedProject: skipped } : {}),
      }),
    );
  });

  // Slack: POST /api/webhooks/slack
  r.post("/slack", webhookReceiverRateLimiter, async (req: Request, res: Response) => {
    const sig = req.header("x-slack-signature");
    const ts = req.header("x-slack-request-timestamp");
    const body = req.body as { team_id?: string; channel_id?: string; command?: string };
    // #680 — signature-first: Slack always sends both the signature and the
    // request-timestamp; reject a request missing either BEFORE the trigger-table
    // scan so unsigned floods cannot amplify DB load.
    if (!sig || !ts) throw new AppError(401, "BAD_SIGNATURE", "Missing Slack signature headers");
    const candidates = await prisma.trigger.findMany({
      where: { source: "slack", enabled: true },
    });
    const matched = candidates.filter((t) => {
      const cfg = parseConfig(t.config);
      const channelOk =
        !cfg.channel || cfg.channel === body?.channel_id || cfg.channel === body?.team_id;
      const commandOk = !cfg.command || cfg.command === body?.command;
      return channelOk && commandOk;
    });
    if (matched.length === 0) {
      res.json(ok({ matched: 0 }));
      return;
    }
    const verified = matched.filter((t) => {
      const cfg = parseConfig(t.config);
      const secret = String(cfg.secret ?? "");
      return verifySlackWebhook(rawBody(req), secret, {
        signature: sig ?? undefined,
        timestamp: ts ?? undefined,
      }).ok;
    });
    // #1438 — see the GitHub receiver above.
    const { live, skipped } = await liveTriggers("trigger.slack", verified);
    if (verified.length > 0 && live.length === 0) throw projectDeletedError();
    const fired: string[] = [];
    // #680 — bound the fan-out per delivery.
    for (const t of live.slice(0, maxTriggerFanout())) {
      const r = await spawnTriggerRun(t, { body });
      fired.push(r.runId);
    }
    res.json(
      ok({
        matched: matched.length,
        fired,
        ...(skipped ? { skippedDeletedProject: skipped } : {}),
      }),
    );
  });

  return r;
}
