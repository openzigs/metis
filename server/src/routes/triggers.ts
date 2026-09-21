/**
 * Epic #156 (#147) — Trigger routes + webhook receivers.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
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
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

const patchSchema = upsertSchema.partial();

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

async function spawnTriggerRun(
  trigger: { id: string; projectId: string; config: unknown; source: string; name: string },
  payload: Record<string, unknown>,
): Promise<{ runId: string }> {
  const cfg = parseConfig(trigger.config);
  const kind = ((cfg.kind as string) || "custom") as "analysis" | "chat" | "browse" | "custom";
  const out = await getAsyncRunner().submit({
    projectId: trigger.projectId,
    kind,
    payload: { triggerId: trigger.id, source: trigger.source, name: trigger.name, ...payload },
  });
  await prisma.trigger.update({
    where: { id: trigger.id },
    data: { lastFiredAt: new Date() },
  });
  return { runId: out.id };
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
        where: { id: String(req.params.id) },
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
      await prisma.trigger.delete({ where: { id: String(req.params.id) } });
      res.json(ok({ ok: true }));
    },
  );

  return r;
}

export function triggersWebhookRouter(): Router {
  const r = Router();

  // #680 — throttle these UNAUTHENTICATED receivers so a flood cannot amplify DB
  // load (the /github and /slack handlers scan the trigger table per request).
  r.use(webhookReceiverRateLimiter);

  // Generic webhook fire: POST /api/triggers/:id/fire
  r.post("/:id/fire", async (req: Request, res: Response) => {
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
    const out = await spawnTriggerRun(trigger, {
      body: req.body,
    });
    res.status(202).json(ok(out));
  });

  // GitHub: POST /api/webhooks/github
  r.post("/github", async (req: Request, res: Response) => {
    const sig = req.header("x-hub-signature-256");
    const event = req.header("x-github-event") ?? "unknown";
    const body = req.body as { repository?: { full_name?: string } };
    const repo = body?.repository?.full_name;
    if (!repo) throw new AppError(400, "BAD_PAYLOAD", "Missing repository.full_name");
    // #680 — signature-first: a genuine GitHub delivery for a secret-protected
    // trigger always carries x-hub-signature-256; reject its absence BEFORE the
    // trigger-table scan so unsigned floods cannot amplify DB load.
    if (!sig) throw new AppError(401, "BAD_SIGNATURE", "Missing x-hub-signature-256");
    const candidates = await prisma.trigger.findMany({
      where: { source: "github", enabled: true },
    });
    const matched = candidates.filter((t) => {
      const cfg = parseConfig(t.config);
      return cfg.repo === repo && (!cfg.event || cfg.event === event);
    });
    if (matched.length === 0) {
      // Always 200 — GitHub treats non-2xx as failure and retries.
      res.json(ok({ matched: 0 }));
      return;
    }
    const verified = matched.filter((t) => {
      const cfg = parseConfig(t.config);
      const secret = String(cfg.secret ?? "");
      return verifyGithubWebhook(rawBody(req), secret, sig).ok;
    });
    const fired: string[] = [];
    // #680 — bound the fan-out per delivery.
    for (const t of verified.slice(0, maxTriggerFanout())) {
      const r = await spawnTriggerRun(t, { event, body });
      fired.push(r.runId);
    }
    res.json(ok({ matched: matched.length, fired }));
  });

  // Slack: POST /api/webhooks/slack
  r.post("/slack", async (req: Request, res: Response) => {
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
    const fired: string[] = [];
    // #680 — bound the fan-out per delivery.
    for (const t of verified.slice(0, maxTriggerFanout())) {
      const r = await spawnTriggerRun(t, { body });
      fired.push(r.runId);
    }
    res.json(ok({ matched: matched.length, fired }));
  });

  return r;
}
