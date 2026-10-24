/**
 * Epic #165 (#112) — `/api/custom-agents` CRUD.
 * Epic #260 (#80/#82/#83) — authoring RBAC, per-project enablement, JSON
 * import/export, and an audited invocation playground.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { patchSchemaOf } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  CustomAgentError,
  createAgent,
  deleteAgent,
  getAgent,
  hasEnablementRow,
  importAgent,
  listAgents,
  listDisabledAgentIdsForProject,
  listEnabledAgentsForProject,
  setAgentEnabledForProject,
  updateAgent,
} from "../lib/custom-agents/index.js";
import {
  assertLiveProjectAccess,
  assertWorkspaceAdminForProject,
} from "../lib/custom-agents/authz.js";
import {
  InvocationError,
  MAX_INVOKE_PAYLOAD_CHARS,
  invokeCustomAgent,
} from "../lib/custom-agents/invoke.js";
import { auditInvocation } from "../lib/custom-agents/invocation-audit.js";
import {
  customAgentEnablerForProject,
  customAgentPlaygroundAccessFor,
} from "../lib/agent-runtime/definition.js";
import { aiRateLimiter } from "../middleware/ai-rate-limit.js";
import { customAgentsPreAuthRateLimiter } from "../middleware/custom-agents-rate-limit.js";
import { assertWithinBudget, BudgetExceededError } from "../lib/finops/budget-enforcer.js";
import {
  AgentImportError,
  exportAgent,
  parseAgentImport,
} from "../lib/custom-agents/portability.js";
import { buildProvider, loadAIConfig } from "../lib/ai/index.js";
import { meterAnalysisProvider, runInAnalysisUsageScope } from "../lib/analysis/analysis-usage.js";
import type { AIProvider } from "../lib/ai/types.js";
import type { AuthPayload, CustomAgentDto, CustomAgentSummaryDto } from "@metis/shared";

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

/**
 * #1445 — may `user` switch agents on for `projectId`? The same check as
 * `PUT /:id/enablement` (a workspace admin, or a system admin). Any refusal of
 * that check (403, or 404/400 for an unreachable or workspace-less project)
 * reads `false`; any other failure propagates.
 */
async function callerMayEnableAgents(user: AuthPayload, projectId: string): Promise<boolean> {
  try {
    await assertWorkspaceAdminForProject(user, projectId);
    return true;
  } catch (err) {
    if (err instanceof AppError && [400, 403, 404].includes(err.statusCode)) return false;
    throw err;
  }
}

/**
 * #1500 — the card's view of an agent, built field by field (an allowlist, so
 * a field later added to the definition is not sent by default).
 */
export function toCustomAgentSummary(agent: CustomAgentDto): CustomAgentSummaryDto {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    isBuiltIn: agent.isBuiltIn,
    projectId: agent.projectId,
  };
}

export interface CustomAgentsRouterDeps {
  /** Provider factory — overridable in tests to inject a deterministic mock. */
  buildProvider?: () => AIProvider;
}

function defaultProvider(): AIProvider {
  return buildProvider({ config: loadAIConfig() });
}

const reasoningEffort = z.enum(["low", "medium", "high"]);
const approvalAction = z.enum(["auto", "prompt-once", "always-prompt", "deny"]);

/**
 * The agent definition's fields, with NO defaults. Both schemas below derive
 * from this one shape; only the create schema adds defaults.
 */
const agentFields = z.object({
  projectId: z.string().min(1),
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[A-Za-z][A-Za-z0-9 _-]+$/),
  description: z.string().max(500),
  systemPrompt: z.string().min(1).max(20_000),
  tools: z.array(z.string()).max(64),
  model: z.string().max(80).nullish(),
  reasoningEffort: reasoningEffort.nullish(),
  // Epic #129 (#145) — the rest of the one agent definition. Values are
  // validated by the service (skills must exist; the override is tighten-only).
  skillKeys: z.array(z.string().max(80)).max(32).optional(),
  approvalPolicy: z
    .object({
      low: approvalAction.optional(),
      medium: approvalAction.optional(),
      high: approvalAction.optional(),
    })
    .strict()
    .nullish(),
});

const createSchema = agentFields.extend({
  description: agentFields.shape.description.default(""),
  tools: agentFields.shape.tools.default([]),
});

/**
 * #145 review round 2 — built from the default-free shape, never from
 * `createSchema.partial()`: under zod 4 `.partial()` still fills an inner
 * `.default()` for an absent key, so a PATCH that sent only the persona
 * wrote `tools: []` and `description: ""`. An absent key must stay
 * `undefined` so the service leaves that column untouched; `null` still
 * clears the nullable fields (model, reasoning effort, approval override).
 */
const patchSchema = patchSchemaOf(agentFields.omit({ projectId: true }));

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
    // #288 — a project's agents are listed only to a caller who can reach that
    // project: 404 otherwise, like every other read on this router. Without a
    // projectId the list is the built-ins alone, open to any signed-in user.
    if (projectId !== null) {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      await assertLiveProjectAccess(req.user, projectId);
    }
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
      await assertLiveProjectAccess(req.user, agent.projectId);
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

  // List agents enabled for a project — as summaries (#1500): any member of
  // the project reads this, and the agents may belong to another project, so
  // it never carries a definition (system prompt, tools, model, skills).
  r.get(
    "/projects/:projectId/enabled",
    customAgentsPreAuthRateLimiter,
    requireAuth,
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = String(req.params.projectId);
      await assertLiveProjectAccess(req.user, projectId);
      try {
        const agents = await listEnabledAgentsForProject(projectId);
        res.json(ok(agents.map(toCustomAgentSummary)));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // #1445 review — ids of agents explicitly switched OFF for a project, so the
  // card can say "Off" for those and "Off until enabled" for the rest.
  r.get(
    "/projects/:projectId/disabled",
    customAgentsPreAuthRateLimiter,
    requireAuth,
    async (req: Request, res: Response) => {
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const projectId = String(req.params.projectId);
      await assertLiveProjectAccess(req.user, projectId);
      res.json(ok(await listDisabledAgentIdsForProject(projectId)));
    },
  );

  // Enable / disable an agent for a project (workspace admin only).
  r.put(
    "/:id/enablement",
    customAgentsPreAuthRateLimiter,
    requireAuth,
    async (req: Request, res: Response) => {
      const parsed = enablementSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      }
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      await assertWorkspaceAdminForProject(req.user, parsed.data.projectId);
      // #305 — the caller must also reach the AGENT's own project, not just the
      // target one: an agent id from another workspace answers 404 exactly like
      // an unknown id, so a foreign agent can never be enabled (and then read
      // back) through a project the caller administers. Built-ins stay open.
      //
      // #1445 review — except switching OFF an agent that already has a row for
      // the target project: it is in use (or was) there, the Custom agents card
      // lists it there, and narrowing what the caller's own project runs reveals
      // nothing about the agent's home project. Without this an agent borrowed
      // from a workspace the admin cannot reach (or whose project was deleted)
      // could be listed on the card but never switched off.
      const switchingOffHere =
        !parsed.data.enabled &&
        (await hasEnablementRow(String(req.params.id), parsed.data.projectId));
      if (!switchingOffHere) await resolveForRead(req);
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
    },
  );

  // ── Epic #260 (#82) — import / export JSON ──────────────────────────────
  r.get("/:id/export", requireAuth, async (req: Request, res: Response) => {
    const agent = await resolveForRead(req);
    res.json(ok(exportAgent(agent)));
  });

  const importSchema = z.object({
    projectId: z.string().min(1).max(64),
    // `.optional()`: zod 4 rejects an absent `z.unknown()` key, zod 3 admitted it (#309).
    document: z.unknown().optional(),
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
      // #145 — an older export may name tools this install does not have; they
      // are dropped (never mapped, never widening) and reported to the caller.
      const { agent, droppedTools } = await importAgent(
        { ...def, projectId: parsed.data.projectId },
        req.user.userId,
      );
      res.status(201).json({ ...ok(agent), meta: { droppedTools } });
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Epic #260 (#80/#83) — invocation playground ─────────────────────────
  const invokeSchema = z.object({
    projectId: z.string().min(1).max(64),
    input: z.string().min(1).max(MAX_INVOKE_PAYLOAD_CHARS),
  });

  // #1445 review — a pre-auth guard (CodeQL counts only a limiter ahead of
  // `requireAuth`), then the same per-user AI limiter chat uses (`routes/ai.ts`).
  r.post(
    "/:id/invoke",
    customAgentsPreAuthRateLimiter,
    requireAuth,
    aiRateLimiter,
    async (req: Request, res: Response) => {
      const parsed = invokeSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      }
      if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      const agentId = String(req.params.id);
      const { projectId, input } = parsed.data;

      // The caller must be able to reach the project context they invoke under.
      await assertLiveProjectAccess(req.user, projectId);

      const agent = await getAgent(agentId);
      if (!agent) throw new AppError(404, "NOT_FOUND", "Custom agent not found");

      // AuthZ: anyone who can reach the project may invoke an agent ENABLED for
      // it. Otherwise treat as not found (do not leak that the agent exists in
      // another scope — IDOR guard), except for the project's OWN agent, whose
      // members can see it and are told why.
      //
      // #1445 — THIS route is the authoring playground, and the "test it before
      // you enable it" exception is applied here and nowhere else: the
      // project's own agent that nobody has switched runs here for a caller who
      // could enable it (a workspace admin, as `PUT /:id/enablement` requires),
      // and for nobody else. Chat, ACP and analysis use
      // `isCustomAgentUsableInProject` (off until enabled), so nothing a chat
      // request claims can reach this rule: it is bound to the route, not to
      // anything in the request.
      const user = req.user;
      const access = await customAgentPlaygroundAccessFor(
        { kind: "custom", id: agentId, projectId: agent.projectId },
        projectId,
        () => callerMayEnableAgents(user, projectId),
      );
      if (access === "switched-off" || access === "off-until-enabled") {
        const switchedOff = access === "switched-off";
        auditInvocation({
          actorId: user.userId,
          agentId,
          projectId,
          outcome: "denied",
          error: switchedOff ? "agent turned off for project" : "agent not yet enabled for project",
        });
        // #1500 — on a project with no workspace only a system admin can enable it.
        const who = switchedOff ? null : await customAgentEnablerForProject(projectId);
        throw new AppError(
          409,
          "AGENT_DISABLED",
          switchedOff
            ? `"${agent.name}" is turned off for this project. Turn it on under Custom agents to use it.`
            : `"${agent.name}" is off for this project until ${who} enables it under Custom agents.`,
        );
      }
      if (access !== "run") {
        // Audit the denied attempt for SOC 2 before masking existence as 404.
        auditInvocation({
          actorId: user.userId,
          agentId,
          projectId,
          outcome: "denied",
          error: "agent not enabled for project",
        });
        throw new AppError(404, "NOT_FOUND", "Custom agent not found");
      }

      // #1445 — the project budget gate chat applies (`routes/ai.ts`), before
      // any model call. After the access check, so the 402's usage figures are
      // only ever shown to someone who may run the agent here.
      try {
        await assertWithinBudget(projectId);
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          throw new AppError(err.status, err.code, err.message, {
            usedTokens: err.usedTokens,
            budget: err.budget,
          });
        }
        throw err;
      }

      try {
        // #724 — playground spend is the project's: meter it and bill it there.
        // The session is per agent AND project — an agent enabled in several
        // projects must not pool every project's invocations into one session.
        const sessionId = `playground:${agentId}:${projectId}`;
        const result = await runInAnalysisUsageScope({ projectId, sessionId }, () =>
          invokeCustomAgent({
            provider: meterAnalysisProvider(makeProvider()),
            agent,
            input,
            projectId,
          }),
        );
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
    },
  );

  return r;
}
