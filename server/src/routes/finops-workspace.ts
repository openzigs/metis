/**
 * /api/workspaces/:workspaceId/finops — FinOps surface for the workspace
 * finops page (Epic #47 / Issue #54).
 *
 * Exposes the latest forecast, budget config, alert-rule CRUD, alert-channel
 * CRUD, alert-event history, and the on-demand chargeback PDF download. All
 * routes require at least workspace `member`; mutations require `admin`.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceRole } from "../middleware/require-workspace-role.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { getLatestForecast } from "../lib/finops/forecast-service.js";
import { buildChargebackReport } from "../lib/finops/chargeback-report.js";

type Req = Request & { params: Record<string, string> };

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

/** Validate a request body; throw a 400 VALIDATION_ERROR on failure. */
function parse<T>(schema: z.ZodSchema<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid payload", {
      issues: parsed.error.errors,
    });
  }
  return parsed.data;
}

const budgetSchema = z.object({
  monthlyBudgetCents: z.number().int().min(0).nullable(),
});

const ruleSchema = z.object({
  name: z.string().min(1).max(120),
  thresholdPct: z.number().int().min(1).max(1000),
  basis: z.enum(["mtd", "projected"]).default("projected"),
  cooldownSec: z.number().int().min(60).max(86_400).default(3600),
  enabled: z.boolean().default(true),
});

const ruleUpdateSchema = ruleSchema.partial();

// Per-type config shape (parsed from the `config` JSON blob) — validated so a
// slack channel always carries a channel id and a pagerduty channel a routing
// service. email/webhook keep their existing shape (config is free-form JSON).
const slackConfigSchema = z.object({
  channel: z.string().min(1).max(200),
});
const pagerDutyConfigSchema = z.object({
  // Optional logical PagerDuty service; defaults to "default" at dispatch time.
  serviceKey: z.string().min(1).max(120).optional(),
});

export const channelSchema = z
  .object({
    // Channel selection (#51): email/webhook/slack/pagerduty. The Slack install
    // (#579) and PagerDuty routing key (#580) are resolved per-workspace at
    // dispatch time — never supplied here.
    type: z.enum(["email", "webhook", "slack", "pagerduty"]),
    target: z.string().max(2048).default(""),
    secret: z.string().max(512).nullable().optional(),
    config: z.string().max(4096).default("{}"),
    enabled: z.boolean().default(true),
  })
  .superRefine((val, ctx) => {
    let parsedConfig: unknown = {};
    try {
      parsedConfig = val.config ? JSON.parse(val.config) : {};
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "config must be valid JSON",
        path: ["config"],
      });
      return;
    }
    if (val.type === "email" || val.type === "webhook") {
      if (!val.target || val.target.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${val.type} channel requires a target`,
          path: ["target"],
        });
      }
    } else if (val.type === "slack") {
      // Slack needs a channel id, from either `target` or `config.channel`.
      const cfg = slackConfigSchema.partial().safeParse(parsedConfig);
      const hasChannel = (cfg.success && cfg.data.channel) || val.target.trim().length > 0;
      if (!hasChannel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "slack channel requires a target channel id (target or config.channel)",
          path: ["target"],
        });
      }
    } else if (val.type === "pagerduty") {
      const cfg = pagerDutyConfigSchema.safeParse(parsedConfig);
      if (!cfg.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "pagerduty config must be {} or { serviceKey }",
          path: ["config"],
        });
      }
    }
  });

export function finopsWorkspaceRouter(): Router {
  const r = Router({ mergeParams: true });

  // ── Forecast (workspace + optional project) ───────────────────────────────
  r.get(
    "/forecast",
    requireAuth,
    requireWorkspaceRole("member"),
    async (req: Req, res: Response) => {
      const { workspaceId } = req.params;
      const projectId = typeof req.query.projectId === "string" ? req.query.projectId : null;
      const forecast = await getLatestForecast(workspaceId, projectId);
      res.json(ok({ forecast }));
    },
  );

  // ── Budget config ─────────────────────────────────────────────────────────
  r.get("/budget", requireAuth, requireWorkspaceRole("member"), async (req: Req, res: Response) => {
    const { workspaceId } = req.params;
    const ws = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { monthlyBudgetCents: true },
    });
    if (!ws) throw new AppError(404, "NOT_FOUND", "Workspace not found");
    res.json(ok({ monthlyBudgetCents: ws.monthlyBudgetCents }));
  });

  r.put("/budget", requireAuth, requireWorkspaceRole("admin"), async (req: Req, res: Response) => {
    const { workspaceId } = req.params;
    const body = parse(budgetSchema, req.body);
    const ws = await prisma.workspace.update({
      where: { id: workspaceId },
      data: { monthlyBudgetCents: body.monthlyBudgetCents },
      select: { monthlyBudgetCents: true },
    });
    res.json(ok({ monthlyBudgetCents: ws.monthlyBudgetCents }));
  });

  // ── Alert rules ───────────────────────────────────────────────────────────
  r.get("/rules", requireAuth, requireWorkspaceRole("member"), async (req: Req, res: Response) => {
    const { workspaceId } = req.params;
    const rules = await prisma.alertRule.findMany({
      where: { workspaceId },
      orderBy: { thresholdPct: "asc" },
    });
    res.json(ok({ rules }));
  });

  r.post("/rules", requireAuth, requireWorkspaceRole("admin"), async (req: Req, res: Response) => {
    const { workspaceId } = req.params;
    const body = parse(ruleSchema, req.body);
    const rule = await prisma.alertRule.create({ data: { workspaceId, ...body } });
    res.status(201).json(ok({ rule }));
  });

  r.patch(
    "/rules/:ruleId",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const { workspaceId, ruleId } = req.params;
      const body = parse(ruleUpdateSchema, req.body);
      const existing = await prisma.alertRule.findFirst({ where: { id: ruleId, workspaceId } });
      if (!existing) throw new AppError(404, "NOT_FOUND", "Alert rule not found");
      const rule = await prisma.alertRule.update({ where: { id: ruleId }, data: body });
      res.json(ok({ rule }));
    },
  );

  r.delete(
    "/rules/:ruleId",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const { workspaceId, ruleId } = req.params;
      const existing = await prisma.alertRule.findFirst({ where: { id: ruleId, workspaceId } });
      if (!existing) throw new AppError(404, "NOT_FOUND", "Alert rule not found");
      await prisma.alertRule.delete({ where: { id: ruleId } });
      res.json(ok({ deleted: true }));
    },
  );

  // ── Alert channels ────────────────────────────────────────────────────────
  r.get(
    "/channels",
    requireAuth,
    requireWorkspaceRole("member"),
    async (req: Req, res: Response) => {
      const { workspaceId } = req.params;
      const channels = await prisma.alertChannel.findMany({
        where: { workspaceId },
        // Never leak the signing secret to the client.
        select: {
          id: true,
          type: true,
          target: true,
          config: true,
          enabled: true,
          createdAt: true,
        },
      });
      res.json(ok({ channels }));
    },
  );

  r.post(
    "/channels",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const { workspaceId } = req.params;
      const body = parse(channelSchema, req.body);
      const created = await prisma.alertChannel.create({
        data: {
          workspaceId,
          type: body.type,
          // `target` defaults to "" for slack/pagerduty (their routing lives in
          // the resolved install/routing key, not a client-supplied target).
          target: body.target ?? "",
          secret: body.secret ?? null,
          config: body.config ?? "{}",
          enabled: body.enabled ?? true,
        },
      });
      res.status(201).json(
        ok({
          channel: {
            id: created.id,
            type: created.type,
            target: created.target,
            config: created.config,
            enabled: created.enabled,
          },
        }),
      );
    },
  );

  r.delete(
    "/channels/:channelId",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const { workspaceId, channelId } = req.params;
      const existing = await prisma.alertChannel.findFirst({
        where: { id: channelId, workspaceId },
      });
      if (!existing) throw new AppError(404, "NOT_FOUND", "Alert channel not found");
      await prisma.alertChannel.delete({ where: { id: channelId } });
      res.json(ok({ deleted: true }));
    },
  );

  // ── Alert event history ───────────────────────────────────────────────────
  r.get("/events", requireAuth, requireWorkspaceRole("member"), async (req: Req, res: Response) => {
    const { workspaceId } = req.params;
    const events = await prisma.alertEvent.findMany({
      where: { workspaceId },
      orderBy: { firedAt: "desc" },
      take: 100,
    });
    res.json(ok({ events }));
  });

  // ── Chargeback PDF download ───────────────────────────────────────────────
  r.get(
    "/chargeback.pdf",
    requireAuth,
    requireWorkspaceRole("member"),
    async (req: Req, res: Response) => {
      const { workspaceId } = req.params;
      const report = await buildChargebackReport(workspaceId);
      if (!report) throw new AppError(404, "NOT_FOUND", "Workspace not found");
      res.setHeader("Content-Type", report.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${report.filename.replace(/[^a-zA-Z0-9._-]/g, "_")}"`,
      );
      // Prevent any content-type sniffing: the body is a binary PDF served as an
      // attachment, so a browser must never re-interpret it as HTML (XSS vector).
      res.setHeader("X-Content-Type-Options", "nosniff");
      // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- binary PDF Buffer, not user-controlled HTML; explicit application/pdf content-type + attachment disposition + nosniff prevent any HTML interpretation.
      res.end(report.pdf);
    },
  );

  return r;
}
