/**
 * Epic #165 (#112) — `/api/custom-agents` CRUD.
 * Epic #260 (#80/#82/#83) — authoring RBAC, per-project enablement, JSON
 * import/export, and an audited invocation playground.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  CustomAgentError,
  createAgent,
  deleteAgent,
  getAgent,
  isAgentEnabledForProject,
  listAgents,
  listEnabledAgentsForProject,
  setAgentEnabledForProject,
  updateAgent,
} from "../lib/custom-agents/index.js";
import { assertProjectAccess, assertWorkspaceAdminForProject } from "../lib/custom-agents/authz.js";
import {
  InvocationError,
  MAX_INVOKE_PAYLOAD_CHARS,
  invokeCustomAgent,
} from "../lib/custom-agents/invoke.js";
import { auditInvocation } from "../lib/custom-agents/invocation-audit.js";
import {
  AgentImportError,
  exportAgent,
  parseAgentImport,
} from "../lib/custom-agents/portability.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import type { AIProvider } from "../lib/ai/types.js";
import type { CustomAgentDto } from "@metis/shared";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof CustomAgentError) {
    throw new AppError(400, "CUSTOM_AGENT_ERROR", err.message);
  }
  if (err instanceof AgentImportError) {
    throw new AppError(400, "AGENT_IMPORT_INVALID", err.message);
  }
  if (err instanceof InvocationError) {
    throw new AppError(400, "INVOCATION_INVALID", err.message);
  }
  throw err;
}

export interface CustomAgentsRouterDeps {
  /** Provider factory — overridable in tests to inject a deterministic mock. */
  buildProvider?: () => AIProvider;
}

function defaultProvider(): AIProvider {
  return buildProvider({ config: loadAIConfig() });
}

const reasoningEffort = z.enum(["low", "medium", "high"]);

const createSchema = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9 _-]+$/),
  description: z.string().max(500).default(""),
  systemPrompt: z.string().min(1).max(20_000),
  tools: z.array(z.string()).max(64).default([]),
  model: z.string().max(80).nullish(),
  reasoningEffort: reasoningEffort.nullish(),
});

const patchSchema = createSchema.partial().omit({ projectId: true });

export function customAgentsRouter(deps: CustomAgentsRouterDeps = {}): Router {
  const r = Router();
  const makeProvider = deps.buildProvider ?? defaultProvider;

  r.get("/", requireAuth, async (req: Request, res: Response) => {
    const projectId =
      typeof req.query.projectId === "string" && req.query.projectId.length > 0
        ? req.query.projectId
        : null;
    // Disable built-ins when the client passes the documented "false"/"0"
    // sentinels. The UI client (sdk-alignment-api.ts) sends "1"/"0", so both
    // forms must be honoured; anything else ("1"/"true"/absent) includes them.
    const includeBuiltIns =
      req.query.includeBuiltIns !== "false" && req.query.includeBuiltIns !== "0";
    try {
      const agents = await listAgents({ projectId, includeBuiltIns });
      res.json(ok(agents));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/", requireAuth, async (req: Request, res: Response) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    // RBAC (#80): only workspace admins/owners may author agents for a project.
    await assertWorkspaceAdminForProject(req.user, parsed.data.projectId);
    try {
      const created = await createAgent(
        {
          ...parsed.data,
          model: parsed.data.model ?? null,
          reasoningEffort: parsed.data.reasoningEffort ?? null,
        },
        actorId(req),
      );
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  /**
   * Resolve the agent and gate access by its owning project.
   *
   * IDOR hardening (#260 review): mutating/reading by id must not let a caller
   * from another workspace touch an agent they cannot reach. We resolve the
   * agent first, then authorize against `agent.projectId`. Cross-scope or
   * non-member access returns 404 (never 403) so existence cannot be probed —
   * matching the invoke route below. Built-in agents (`projectId === null`) are
   * readable by any accessible caller but stay non-mutable (the service layer
   * enforces the built-in guard).
   */
  async function resolveForRead(req: Request): Promise<CustomAgentDto> {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const agent = await getAgent(String(req.params.id));
    if (!agent) throw new AppError(404, "NOT_FOUND", "Custom agent not found");
    if (agent.projectId !== null) {
      await assertProjectAccess(req.user, agent.projectId);
    }
    return agent;
  }

  async function resolveForMutate(req: Request): Promise<CustomAgentDto> {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const agent = await getAgent(String(req.params.id));
    if (!agent) throw new AppError(404, "NOT_FOUND", "Custom agent not found");
    if (agent.projectId !== null) {
      await assertWorkspaceAdminForProject(req.user, agent.projectId);
    }
    return agent;
  }

  r.patch("/:id", requireAuth, async (req: Request, res: Response) => {
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    await resolveForMutate(req);
    try {
      const updated = await updateAgent(String(req.params.id), parsed.data, actorId(req));
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete("/:id", requireAuth, async (req: Request, res: Response) => {
    await resolveForMutate(req);
    try {
      await deleteAgent(String(req.params.id), actorId(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  r.get("/:id", requireAuth, async (req: Request, res: Response) => {
    const agent = await resolveForRead(req);
    res.json(ok(agent));
  });

  // ── Epic #260 (#79/#80) — per-project enablement ────────────────────────
  const enablementSchema = z.object({
    projectId: z.string().min(1).max(64),
    enabled: z.boolean().default(true),
  });

  // List agents enabled for a project.
  r.get("/projects/:projectId/enabled", requireAuth, async (req: Request, res: Response) => {
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const projectId = String(req.params.projectId);
    await assertProjectAccess(req.user, projectId);
    try {
      const agents = await listEnabledAgentsForProject(projectId);
      res.json(ok(agents));
    } catch (err) {
      rethrow(err);
    }
  });

  // Enable / disable an agent for a project (workspace admin only).
  r.put("/:id/enablement", requireAuth, async (req: Request, res: Response) => {
    const parsed = enablementSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    await assertWorkspaceAdminForProject(req.user, parsed.data.projectId);
    try {
      const row = await setAgentEnabledForProject(
        String(req.params.id),
        parsed.data.projectId,
        parsed.data.enabled,
        req.user.userId,
      );
      res.json(ok(row));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Epic #260 (#82) — import / export JSON ──────────────────────────────
  r.get("/:id/export", requireAuth, async (req: Request, res: Response) => {
    const agent = await resolveForRead(req);
    res.json(ok(exportAgent(agent)));
  });

  const importSchema = z.object({
    projectId: z.string().min(1).max(64),
    document: z.unknown(),
  });

  r.post("/import", requireAuth, async (req: Request, res: Response) => {
    const parsed = importSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    await assertWorkspaceAdminForProject(req.user, parsed.data.projectId);
    try {
      const def = parseAgentImport(parsed.data.document);
      const created = await createAgent(
        { ...def, projectId: parsed.data.projectId },
        req.user.userId,
      );
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Epic #260 (#80/#83) — invocation playground ─────────────────────────
  const invokeSchema = z.object({
    projectId: z.string().min(1).max(64),
    input: z.string().min(1).max(MAX_INVOKE_PAYLOAD_CHARS),
  });

  r.post("/:id/invoke", requireAuth, async (req: Request, res: Response) => {
    const parsed = invokeSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
    const agentId = String(req.params.id);
    const { projectId, input } = parsed.data;

    // The caller must be able to reach the project context they invoke under.
    await assertProjectAccess(req.user, projectId);

    const agent = await getAgent(agentId);
    if (!agent) throw new AppError(404, "NOT_FOUND", "Custom agent not found");

    // AuthZ: anyone may invoke IF the agent is enabled for this project, OR
    // the agent is owned by this exact project. Otherwise treat as not found
    // (do not leak that the agent exists in another scope — IDOR guard).
    const ownedByProject = agent.projectId === projectId;
    const enabled = ownedByProject || (await isAgentEnabledForProject(agentId, projectId));
    if (!enabled) {
      // Audit the denied attempt for SOC 2 before masking existence as 404.
      auditInvocation({
        actorId: req.user.userId,
        agentId,
        projectId,
        outcome: "denied",
        error: "agent not enabled for project",
      });
      throw new AppError(404, "NOT_FOUND", "Custom agent not found");
    }

    try {
      const result = await invokeCustomAgent({
        provider: makeProvider(),
        agent,
        input,
      });
      auditInvocation({
        actorId: req.user.userId,
        agentId,
        projectId,
        outcome: "success",
        usage: result.usage,
      });
      res.json(ok(result));
    } catch (err) {
      auditInvocation({
        actorId: req.user.userId,
        agentId,
        projectId,
        outcome: "error",
        error: err instanceof Error ? err.message : String(err),
      });
      rethrow(err);
    }
  });

  return r;
}
