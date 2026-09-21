/**
 * Epic #708 / Issue #710 — Rule authoring API.
 *
 * Endpoints (mounted at /api/projects/:projectId/rule-sets):
 *   GET    /                       — list rule sets + rules
 *   POST   /                       — create a rule set
 *   POST   /:setId/rules           — add a draft rule
 *   POST   /:setId/rules/:id/compile  — compile a draft rule
 *   POST   /:setId/rules/:id/grade    — record exemplar grades (>=5)
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import type { AIProvider } from "../lib/ai/types.js";
import { compileRule, normaliseCompiledMeta } from "../lib/scanner/rule-compiler.js";
import {
  SCANNER_SUPPORTED_LANGUAGES_ARRAY,
  RULE_STATUS_VALUES,
  SEVERITY_VALUES,
  type RuleStatus,
  type Severity,
} from "../lib/scanner/types.js";

let cachedProvider: AIProvider | null = null;
function getProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = buildProvider({ config: loadAIConfig() });
  return cachedProvider;
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId is required");
  return id;
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

const createSetSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
});

const createRuleSchema = z.object({
  naturalLanguage: z.string().min(10).max(8000),
  severity: z.enum(SEVERITY_VALUES as unknown as [Severity, ...Severity[]]).optional(),
  category: z.string().max(64).optional(),
});

const exemplarGradeSchema = z.object({
  exemplars: z
    .array(
      z.object({
        codeSnippet: z.string().min(1).max(20_000),
        language: z.enum(SCANNER_SUPPORTED_LANGUAGES_ARRAY as unknown as [string, ...string[]]),
        expectedFinding: z.boolean(),
        humanGrade: z.enum(["true_positive", "false_positive", "ambiguous"]),
        note: z.string().max(2000).optional(),
      }),
    )
    .min(5, "At least five exemplar grades are required before activation"),
});

const MIN_EXEMPLAR_GRADES = 5;

export function rulesRouter(): Router {
  const r = Router({ mergeParams: true });

  // ----- Rule sets -----
  r.get(
    "/",
    requireAuth,
    requirePermission("project.read"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const ruleSets = await prisma.ruleSet.findMany({
        where: { projectId },
        include: { rules: true },
        orderBy: { createdAt: "asc" },
      });
      res.json({ success: true, data: ruleSets });
    },
  );

  r.post(
    "/",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const parsed = createSetSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid rule-set payload", {
          issues: parsed.error.flatten(),
        });
      }
      const userId = actor(req);
      try {
        const row = await prisma.ruleSet.create({
          data: {
            projectId,
            name: parsed.data.name,
            description: parsed.data.description ?? undefined,
            isActive: true,
            createdById: userId,
          },
        });
        audit({
          actor: { id: userId },
          action: "scanner.rule-set.create",
          target: { type: "rule_set", id: row.id },
          metadata: { projectId, name: row.name },
        });
        res.status(201).json({ success: true, data: row });
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") {
          throw new AppError(409, "RULE_SET_EXISTS", "A rule set with this name already exists");
        }
        throw err;
      }
    },
  );

  // ----- Rules -----
  r.post(
    "/:setId/rules",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const ruleSetId = String(req.params.setId);
      const parsed = createRuleSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid rule payload", {
          issues: parsed.error.flatten(),
        });
      }
      const set = await prisma.ruleSet.findFirst({ where: { id: ruleSetId, projectId } });
      if (!set) throw new AppError(404, "RULE_SET_NOT_FOUND", "Rule set not found");

      const row = await prisma.rule.create({
        data: {
          ruleSetId,
          naturalLanguage: parsed.data.naturalLanguage,
          status: "draft" satisfies RuleStatus,
          severity: parsed.data.severity ?? "medium",
          category: parsed.data.category ?? "correctness",
        },
      });
      audit({
        actor: { id: actor(req) },
        action: "scanner.rule.create",
        target: { type: "rule", id: row.id },
        metadata: { projectId, ruleSetId },
      });
      res.status(201).json({ success: true, data: row });
    },
  );

  r.post(
    "/:setId/rules/:ruleId/compile",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const ruleSetId = String(req.params.setId);
      const ruleId = String(req.params.ruleId);
      const rule = await prisma.rule.findFirst({
        where: { id: ruleId, ruleSetId, ruleSet: { projectId } },
      });
      if (!rule) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found");

      await prisma.rule.update({
        where: { id: ruleId },
        data: { status: "compiling" },
      });
      try {
        const result = await compileRule(getProvider(), {
          naturalLanguage: rule.naturalLanguage,
        });
        const meta = normaliseCompiledMeta(result.meta);
        const updated = await prisma.rule.update({
          where: { id: ruleId },
          data: {
            status: "awaiting_grading",
            compiledMeta: JSON.stringify(meta),
            errorMessage: null,
          },
        });
        audit({
          actor: { id: actor(req) },
          action: "scanner.rule.compile",
          target: { type: "rule", id: ruleId },
          metadata: { projectId, kinds: meta.symbolKinds.length },
        });
        res.json({ success: true, data: updated });
      } catch (err) {
        const message = (err as Error).message?.slice(0, 1000) ?? "compile failed";
        await prisma.rule.update({
          where: { id: ruleId },
          data: { status: "failed", errorMessage: message },
        });
        throw new AppError(502, "RULE_COMPILE_FAILED", message);
      }
    },
  );

  r.post(
    "/:setId/rules/:ruleId/grade",
    requireAuth,
    requirePermission("project.update"),
    async (req: Request, res: Response) => {
      const projectId = projectIdOf(req);
      const ruleSetId = String(req.params.setId);
      const ruleId = String(req.params.ruleId);
      const parsed = exemplarGradeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid grading payload", {
          issues: parsed.error.flatten(),
        });
      }
      if (parsed.data.exemplars.length < MIN_EXEMPLAR_GRADES) {
        throw new AppError(
          422,
          "INSUFFICIENT_EXEMPLARS",
          `At least ${MIN_EXEMPLAR_GRADES} exemplar grades required`,
        );
      }
      const rule = await prisma.rule.findFirst({
        where: { id: ruleId, ruleSetId, ruleSet: { projectId } },
      });
      if (!rule) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found");
      if (rule.status !== "awaiting_grading" && rule.status !== "active") {
        throw new AppError(
          409,
          "RULE_NOT_GRADABLE",
          `Rule must be in awaiting_grading state (current: ${rule.status})`,
        );
      }
      const updated = await prisma.rule.update({
        where: { id: ruleId },
        data: {
          status: "active",
          exemplarGrades: JSON.stringify(parsed.data.exemplars),
        },
      });
      audit({
        actor: { id: actor(req) },
        action: "scanner.rule.activate",
        target: { type: "rule", id: ruleId },
        metadata: { projectId, exemplarCount: parsed.data.exemplars.length },
      });
      res.json({ success: true, data: updated });
    },
  );

  return r;
}

// Re-export valid status set for tests / docs.
export { RULE_STATUS_VALUES };
