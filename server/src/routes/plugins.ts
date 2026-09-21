/**
 * Epic #165 (#115) — Plugin export / import.
 *
 * `POST /api/plugins/export` builds a `metis-plugin-<slug>.json` envelope
 * from the named skills/agents/hooks and streams it as a download.
 * `POST /api/plugins/import` accepts the same envelope and registers the
 * contained skills/agents/hooks against the target project.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { AppError } from "../middleware/error-handler.js";
import {
  PluginFormatError,
  pack,
  pluginFileName,
  unpack,
  type PluginEnvelope,
  type PluginHook,
  type PluginSkill,
} from "../lib/plugins/index.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import { createSubscription } from "../lib/hooks/index.js";
import { createAgent } from "../lib/custom-agents/index.js";
import type { CustomAgentDefinition } from "@metis/shared";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof PluginFormatError) {
    throw new AppError(400, "PLUGIN_FORMAT", err.message);
  }
  throw err;
}

const exportSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9-]+$/),
  version: z
    .string()
    .min(1)
    .max(32)
    .regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?$/),
  description: z.string().max(500).default(""),
  skillIds: z.array(z.string().min(1)).max(100).default([]),
  customAgentIds: z.array(z.string().min(1)).max(100).default([]),
  hookIds: z.array(z.string().min(1)).max(100).default([]),
});

const importSchema = z.object({
  projectId: z.string().min(1),
  envelope: z.unknown(),
});

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function pluginsRouter(): Router {
  const r = Router();

  r.post("/export", requireAuth, async (req: Request, res: Response) => {
    const parsed = exportSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);

    try {
      // Skills
      const skillRows = parsed.data.skillIds.length
        ? await prisma.skill.findMany({
            where: { id: { in: parsed.data.skillIds }, deletedAt: null },
          })
        : [];
      const skills: PluginSkill[] = skillRows.map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        instructions: s.instructions,
        tools: (safeParseJson(s.tools) as string[] | null) ?? [],
        tags: (safeParseJson(s.tags) as string[] | null) ?? [],
      }));

      // Agents
      const agentRows = parsed.data.customAgentIds.length
        ? await prisma.customAgent.findMany({
            where: { id: { in: parsed.data.customAgentIds } },
          })
        : [];
      const agents: CustomAgentDefinition[] = agentRows.map((a) => ({
        name: a.name,
        description: a.description,
        systemPrompt: a.systemPrompt,
        tools: (safeParseJson(a.tools) as string[] | null) ?? [],
        model: a.model,
        reasoningEffort: (a.reasoningEffort as CustomAgentDefinition["reasoningEffort"]) ?? null,
      }));

      // Hooks
      const hookRows = parsed.data.hookIds.length
        ? await prisma.hookSubscription.findMany({ where: { id: { in: parsed.data.hookIds } } })
        : [];
      const hooks: PluginHook[] = hookRows.map((h) => ({
        event: h.event as PluginHook["event"],
        handlerKind: h.handlerKind as PluginHook["handlerKind"],
        config: (safeParseJson(h.config) as Record<string, unknown> | null) ?? {},
      }));

      const buf = pack({
        manifest: {
          name: parsed.data.name,
          version: parsed.data.version,
          description: parsed.data.description,
        },
        skills,
        agents,
        hooks,
      });

      audit({
        actor: { id: actorId(req) },
        action: "plugin.exported",
        target: { type: "plugin", id: parsed.data.name },
        metadata: {
          version: parsed.data.version,
          skillCount: skills.length,
          agentCount: agents.length,
          hookCount: hooks.length,
        },
      });

      res.setHeader("content-type", "application/json");
      res.setHeader(
        "content-disposition",
        `attachment; filename="${pluginFileName(parsed.data.name)}"`,
      );
      res.status(200).send(buf);
    } catch (err) {
      rethrow(err);
    }
  });

  // SECURITY (OWASP A01 / BOLA — epic #671, #678): import installs skills,
  // custom agents, and hook subscriptions into the project named in the request
  // BODY. Two layers gate it:
  //  1. Role scope (`requirePermission("mcp.manage")`) — the same scope the
  //     sibling #675 hooks router requires to create hook subscriptions, which
  //     import also does via `createSubscription`. Coordinator carries it; a
  //     wrong role → 403.
  //  2. Object-level scope (`assertProjectAccess`) — the caller must be a member
  //     of the target project's workspace; an out-of-tenant or unknown project
  //     → 404 (no existence oracle), system admins bypass.
  r.post(
    "/import",
    requireAuth,
    requirePermission("mcp.manage"),
    async (req: Request, res: Response) => {
      const parsed = importSchema.safeParse(req.body);
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      const { projectId, envelope: rawEnvelope } = parsed.data;

      // Object-level authorization before any work: non-members and unknown
      // project ids get 404 alike, so route probing cannot enumerate projects.
      await assertProjectAccess(req.user!, projectId);

      let env: PluginEnvelope;
      try {
        const buf =
          typeof rawEnvelope === "string"
            ? Buffer.from(rawEnvelope, "utf-8")
            : Buffer.from(JSON.stringify(rawEnvelope), "utf-8");
        env = unpack(buf);
      } catch (err) {
        rethrow(err);
      }

      // Verify project exists. `assertProjectAccess` already 404s unknown
      // projects for non-admins; this re-check also 404s for a system admin
      // (who bypasses the membership check) importing into a stale/deleted id.
      const proj = await prisma.project.findUnique({ where: { id: projectId } });
      if (!proj) throw new AppError(404, "NOT_FOUND", "Project not found");

      const installed = {
        skills: 0,
        agents: 0,
        hooks: 0,
      };

      // Skills — register against the project library as inline skills. We
      // keep this minimal: insert a Skill row per envelope skill, ignoring
      // duplicates by (name, version).
      for (const s of env.skills) {
        const key = `imported-${env.manifest.name}-${s.name}`
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 80);
        try {
          await prisma.skill.create({
            data: {
              key,
              name: s.name,
              description: s.description,
              version: s.version,
              instructions: s.instructions,
              tools: JSON.stringify(s.tools),
              tags: JSON.stringify(s.tags),
              source: `plugin:${env.manifest.name}`,
              createdById: actorId(req),
            },
          });
          installed.skills++;
        } catch {
          // duplicate key — skip silently.
        }
      }

      // Agents — register as project-scoped custom agents. Skip duplicates by
      // (projectId, name).
      for (const a of env.agents) {
        try {
          await createAgent(
            {
              projectId,
              name: a.name,
              description: a.description,
              systemPrompt: a.systemPrompt,
              tools: a.tools,
              model: a.model ?? null,
              reasoningEffort: a.reasoningEffort ?? null,
            },
            actorId(req),
          );
          installed.agents++;
        } catch {
          // duplicate or validation failure — skip.
        }
      }

      // Hooks — install disabled by default per AC #115.4 (sandboxed; require
      // explicit per-project enablement).
      for (const h of env.hooks) {
        try {
          await createSubscription(
            {
              projectId,
              event: h.event,
              handlerKind: h.handlerKind,
              config: h.config,
              enabled: false,
            },
            actorId(req),
          );
          installed.hooks++;
        } catch {
          // skip
        }
      }

      audit({
        actor: { id: actorId(req) },
        action: "plugin.imported",
        target: { type: "plugin", id: env.manifest.name },
        metadata: { projectId, ...installed, version: env.manifest.version },
      });

      res.status(201).json(ok({ manifest: env.manifest, installed }));
    },
  );

  return r;
}
