/**
 * Agent Client Protocol (ACP) handlers — Epic #163, Issue #119.
 *
 * Pure JSON-RPC 2.0 method handlers. Transport-agnostic so the same
 * implementations are reused by:
 *
 *   - The WebSocket server in `server.ts` (`wss://server/api/acp`)
 *   - The stdio bridge for local Copilot CLI integration
 *   - Unit tests
 *
 * Methods (named per the ACP spec, kebab-case):
 *
 *   - `list-projects`   → ProjectSummary[]
 *   - `list-skills`     → SkillSummary[] (project-scoped)
 *   - `list-agents`     → AgentSummary[] (project-scoped)
 *   - `run-agent`       → { runId } (kicks off a background run)
 *   - `stream-tokens`   → an async generator of token chunks (transport
 *                          adapters convert this into JSON-RPC notifications
 *                          like `acp.token`).
 *
 * Auth: every handler requires a verified `VerifiedToken` (see api-tokens.ts).
 * Per AC #3, unauthenticated requests are rejected with the documented
 * error code `ACP_UNAUTHORIZED` (-32001).
 */
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { assertProjectAccess } from "../custom-agents/authz.js";
import type { VerifiedToken } from "./api-tokens.js";
import {
  ACP_METHOD_SCOPES,
  accessibleProjectWhere,
  isAdminActor,
  listAccessibleProjectIds,
  resolveAcpActor,
  tokenHasScope,
} from "./authz.js";

// ---- JSON-RPC envelopes ---------------------------------------------------
export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: number | string | null;
  result: unknown;
}

export interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

// ---- Documented error codes (AC #3) --------------------------------------
export const ACP_ERR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  // Custom server errors (range -32000 to -32099 reserved for impl).
  UNAUTHORIZED: -32001,
  FORBIDDEN: -32002,
  RATE_LIMITED: -32003,
  PROJECT_NOT_FOUND: -32010,
  AGENT_NOT_FOUND: -32011,
} as const;

export interface AcpContext {
  /** Verified bearer token. Null when no token was provided. */
  auth: VerifiedToken | null;
}

/**
 * Context handed to individual handlers after `dispatchAcp` has verified the
 * token, enforced the method scope, and resolved the caller into the
 * `AuthPayload` the tenant-authz helpers consume.
 */
export interface AuthedAcpContext {
  auth: VerifiedToken;
  actor: AuthPayload;
}

// ---- Method dispatch table ------------------------------------------------
type Handler = (params: unknown, ctx: AuthedAcpContext) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  "list-projects": handleListProjects,
  "list-skills": handleListSkills,
  "list-agents": handleListAgents,
  "run-agent": handleRunAgent,
  // Note: "stream-tokens" is NOT a JSON-RPC method — it's a notification
  // stream initiated by `run-agent`. Adapters subscribe to per-run events
  // and emit `{method:"acp.token", params:{runId, delta}}` notifications.
};

export async function dispatchAcp(req: JsonRpcRequest, ctx: AcpContext): Promise<JsonRpcResponse> {
  if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
    return errorResponse(req.id ?? null, ACP_ERR.INVALID_REQUEST, "invalid jsonrpc envelope");
  }
  if (!ctx.auth) {
    return errorResponse(
      req.id ?? null,
      ACP_ERR.UNAUTHORIZED,
      "ACP_UNAUTHORIZED: bearer token required",
    );
  }
  const handler = HANDLERS[req.method];
  if (!handler) {
    return errorResponse(
      req.id ?? null,
      ACP_ERR.METHOD_NOT_FOUND,
      `method '${req.method}' not found`,
    );
  }
  // BFLA: enforce that the token's scopes cover the requested method. This is
  // about the token's own capability (not resource existence), so FORBIDDEN is
  // appropriate — no tenant existence is leaked here.
  const requiredScope = ACP_METHOD_SCOPES[req.method];
  if (requiredScope && !tokenHasScope(ctx.auth.scopes, requiredScope)) {
    return errorResponse(
      req.id ?? null,
      ACP_ERR.FORBIDDEN,
      `ACP_FORBIDDEN: token missing required scope '${requiredScope}'`,
    );
  }
  try {
    const actor = await resolveAcpActor(ctx.auth);
    const authed: AuthedAcpContext = { auth: ctx.auth, actor };
    const result = await handler(req.params ?? {}, authed);
    return { jsonrpc: "2.0", id: req.id ?? null, result };
  } catch (err) {
    const e = err as {
      acpCode?: number;
      message?: string;
      status?: number;
      statusCode?: number;
    };
    // Tenant-authz helpers throw `AppError` (which uses `statusCode`); map any
    // 404 to PROJECT_NOT_FOUND so "no access" is indistinguishable from
    // "does not exist" (no existence oracle — OWASP A01).
    const httpStatus = e.statusCode ?? e.status;
    const code =
      typeof e.acpCode === "number"
        ? e.acpCode
        : httpStatus === 404
          ? ACP_ERR.PROJECT_NOT_FOUND
          : ACP_ERR.INTERNAL;
    return errorResponse(req.id ?? null, code, e.message ?? "internal error");
  }
}

function errorResponse(id: number | string | null, code: number, message: string): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ---- Handlers --------------------------------------------------------------

interface ProjectSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
}

async function handleListProjects(
  _params: unknown,
  ctx: AuthedAcpContext,
): Promise<ProjectSummary[]> {
  // Tenant scope: only projects the caller can access (workspace membership /
  // open projects; admins see all). Never instance-wide for a non-admin.
  const rows = await prisma.project.findMany({
    where: accessibleProjectWhere(ctx.actor),
    select: { id: true, name: true, slug: true, status: true },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return rows;
}

interface SkillSummary {
  id: string;
  name: string;
  description: string;
}

async function handleListSkills(params: unknown, ctx: AuthedAcpContext): Promise<SkillSummary[]> {
  const projectId = pickStringParam(params, "projectId");
  // A specific project filter must be one the caller can reach (404-equivalent
  // otherwise — no existence oracle).
  if (projectId) await assertProjectAccess(ctx.actor, projectId);

  let where: Record<string, unknown>;
  if (isAdminActor(ctx.actor)) {
    where = projectId
      ? { deletedAt: null, allowlists: { some: { projectId, enabled: true } } }
      : { deletedAt: null };
  } else {
    // Skills have no owning project — tenancy is expressed via
    // `ProjectSkillAllowlist`. A non-admin sees: the shared library (skills not
    // allowlisted to ANY project), skills they authored, and skills allowlisted
    // to a project they can access. Skills allowlisted ONLY to inaccessible
    // projects stay hidden (no cross-tenant enumeration).
    const scopeIds = projectId ? [projectId] : await listAccessibleProjectIds(ctx.actor);
    const allow = await prisma.projectSkillAllowlist.findMany({
      where: { projectId: { in: scopeIds }, enabled: true },
      select: { skillId: true },
    });
    const allowedSkillIds = [...new Set(allow.map((a) => a.skillId))];
    where = projectId
      ? { deletedAt: null, id: { in: allowedSkillIds } }
      : {
          deletedAt: null,
          OR: [
            { id: { in: allowedSkillIds } },
            { createdById: ctx.actor.userId },
            { allowlists: { none: {} } },
          ],
        };
  }
  const rows = await prisma.skill.findMany({
    where,
    select: { id: true, name: true, description: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return rows;
}

interface AgentSummary {
  id: string;
  key: string;
  name: string;
  description: string;
}

async function handleListAgents(params: unknown, ctx: AuthedAcpContext): Promise<AgentSummary[]> {
  const projectId = pickStringParam(params, "projectId");
  if (projectId) await assertProjectAccess(ctx.actor, projectId);

  let where: Record<string, unknown>;
  if (isAdminActor(ctx.actor)) {
    // Admin: all agents, optionally narrowed to a project (plus the built-in
    // fleet, which has `projectId === null`).
    where = projectId ? { OR: [{ projectId }, { projectId: null }] } : {};
  } else {
    // Non-admin: the built-in fleet (global, `projectId === null`) plus agents
    // owned by a project the caller can access. Foreign-project agents stay
    // hidden — no cross-tenant enumeration.
    const scopeIds = projectId ? [projectId] : await listAccessibleProjectIds(ctx.actor);
    where = { OR: [{ projectId: null }, { projectId: { in: scopeIds } }] };
  }
  const customs = await prisma.customAgent.findMany({
    where,
    select: { id: true, name: true, description: true },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return customs.map((c) => ({
    id: c.id,
    // CustomAgent has no separate `key` column — `name` is the unique
    // identifier per project (per `@@unique([projectId, name])`). Surface
    // it as `key` in the ACP response for consistency with the spec.
    key: c.name,
    name: c.name,
    description: c.description ?? "",
  }));
}

interface RunAgentParams {
  projectId: string;
  agentKey: string;
  prompt?: string;
  payload?: Record<string, unknown>;
}

async function handleRunAgent(params: unknown, ctx: AuthedAcpContext): Promise<{ runId: string }> {
  const p = parseRunAgentParams(params);
  // Parity with the REST twin `POST /api/custom-agents/:id/invoke`
  // (custom-agents.ts:277): the caller must be able to reach the target
  // project. Non-members get a 404-equivalent (AppError 404 → PROJECT_NOT_FOUND
  // in dispatch) so project existence is never leaked.
  await assertProjectAccess(ctx.actor, p.projectId);

  // Resolve the agent SCOPED TO THE PROJECT — never a global name lookup.
  // Mirror the REST twin's "owned by this project OR enabled for this project"
  // enablement check. Anything else is masked as AGENT_NOT_FOUND (no oracle).
  const agent = await resolveAgentForProject(p.projectId, p.agentKey);
  if (!agent) {
    // Audit the denied attempt for SOC 2 before masking existence.
    audit({
      actor: { id: ctx.actor.userId },
      action: "acp.run-agent.denied",
      target: { type: "custom_agent", id: p.agentKey },
      metadata: { projectId: p.projectId, reason: "agent-not-accessible" },
    });
    const err = new Error(`agent ${p.agentKey} not found`);
    (err as { acpCode?: number }).acpCode = ACP_ERR.AGENT_NOT_FOUND;
    throw err;
  }
  const run = await prisma.backgroundRun.create({
    data: {
      projectId: p.projectId,
      kind: "acp.run-agent",
      payload: JSON.stringify({
        agentKey: p.agentKey,
        prompt: p.prompt ?? null,
        ...(p.payload ?? {}),
        acp: {
          tokenId: ctx.auth.tokenId,
          actorUserId: ctx.actor.userId,
        },
      }),
      status: "queued",
    },
    select: { id: true },
  });
  return { runId: run.id };
}

// ---- Param parsing --------------------------------------------------------

function pickStringParam(params: unknown, key: string): string | null {
  if (params && typeof params === "object") {
    const v = (params as Record<string, unknown>)[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function parseRunAgentParams(params: unknown): RunAgentParams {
  if (!params || typeof params !== "object") {
    const err = new Error("params must be an object");
    (err as { acpCode?: number }).acpCode = ACP_ERR.INVALID_PARAMS;
    throw err;
  }
  const obj = params as Record<string, unknown>;
  const projectId = typeof obj.projectId === "string" ? obj.projectId : "";
  const agentKey = typeof obj.agentKey === "string" ? obj.agentKey : "";
  if (!projectId || !agentKey) {
    const err = new Error("projectId and agentKey are required");
    (err as { acpCode?: number }).acpCode = ACP_ERR.INVALID_PARAMS;
    throw err;
  }
  const prompt = typeof obj.prompt === "string" ? obj.prompt : undefined;
  const payload =
    obj.payload && typeof obj.payload === "object"
      ? (obj.payload as Record<string, unknown>)
      : undefined;
  return { projectId, agentKey, prompt, payload };
}

/**
 * Resolve a custom agent by name WITHIN a project's scope. Mirrors the REST
 * twin's "owned by this project OR enabled for this project" rule
 * (custom-agents.ts:285-286): an agent is runnable in `projectId` when it is
 * owned by that project, or a foreign/built-in agent explicitly enabled for it
 * via `CustomAgentEnablement`. A bare global name lookup is never used.
 */
async function resolveAgentForProject(
  projectId: string,
  agentKey: string,
): Promise<{ id: string; name: string } | null> {
  const owned = await prisma.customAgent.findFirst({
    where: { projectId, name: agentKey },
    select: { id: true, name: true },
  });
  if (owned) return owned;

  const enablements = await prisma.customAgentEnablement.findMany({
    where: { projectId, enabled: true },
    select: { customAgentId: true },
  });
  if (enablements.length === 0) return null;
  return prisma.customAgent.findFirst({
    where: { id: { in: enablements.map((e) => e.customAgentId) }, name: agentKey },
    select: { id: true, name: true },
  });
}

export const __testing = {
  HANDLERS,
  parseRunAgentParams,
  pickStringParam,
  resolveAgentForProject,
};
