/**
 * /api/mcp — MCP server registry routes (Phase 6).
 *
 * RBAC: every endpoint requires `mcp.manage` (admin role only by default).
 * Per-project allow-list endpoints additionally require `project.update`
 * within the route handler so coordinators of a project can attach servers
 * without becoming admins.
 *
 * #305 — role permissions are not a grant over every workspace's projects.
 * Any route that takes a project id (the per-project allow-list routes, the
 * `?projectId=` list filter, and every create that binds a server to a
 * project) also passes `assertProjectAccess` for that id: 404 without access.
 *
 * #311 — every route that acts on an EXISTING server by id resolves the server
 * first (`assertServerAccess`). A `scope: "project"` server is reached only
 * through its own project's access check, and an unreachable one answers the
 * same 404 as an unknown id before anything is read or changed. `global`
 * servers stay a registry-wide role permission (`mcp.manage` / `mcp.read` /
 * `mcp.write`), as designed. The unfiltered lists (`GET /`, `GET /export`)
 * omit project-scoped servers in projects the caller cannot reach.
 *
 * #340 — a `scope: "user"` server belongs to one user (`userId`). Only that
 * owner and system admins reach it by id; anyone else gets the unknown-id
 * 404, and the unfiltered lists show a non-admin only their own user servers.
 *
 * Audit + secret hygiene live inside `MCPRegistryService` — the routes are
 * thin glue.
 */
import { Router, type Request } from "express";
import { type ApiResponse, createMCPServerSchema, updateMCPServerSchema } from "@metis/shared";
import { audit } from "../lib/audit/audit-service.js";
import { getMCPRegistry, MCPRegistryService } from "../lib/mcp/index.js";
import { mcpConcurrentUpdateError } from "../lib/mcp/mcp-service-error.js";
import {
  MCPRegistryError,
  PROJECT_REQUIRED,
  PROJECT_REQUIRED_MESSAGE,
} from "../lib/mcp/mcp-service.js";
import {
  executeImport,
  importStatus,
  buildImportPlan,
  isSecretHeaderName,
  isSecretValue,
  SECRET_KEY_PATTERN,
} from "../lib/mcp/mcp-importer.js";
import { fetchRegistry } from "../lib/mcp/registry-client.js";
import { decideApproval } from "../lib/mcp/approval.js";
import { prisma } from "../lib/prisma.js";
import { loadAuthorizedSession } from "../lib/ai/conversation/session-access.js";
import {
  searchFederated,
  getEntryById,
  recordLocalInstall,
  refreshSource,
  type FederationSource,
} from "../lib/mcp/federation/registry-cache.js";
import { diffSchemas, snapshotToolSchemas } from "../lib/mcp/integrity.js";
import { exportToCopilotMcpJson, parseCopilotMcpJson } from "../lib/mcp/mcp-json-format.js";
import { scanForHiddenChars } from "../lib/mcp/hidden-char-scanner.js";
import { getVaultService } from "../lib/vault/vault-service.js";
import { freshSecretLabel } from "../lib/vault/secret-rotation.js";
import { withdrawCreatedSecrets } from "../lib/vault/secret-retirement.js";
import type { SecretBindings } from "../lib/vault/bound-secret.js";
import { assertBindingWriteWindowOpen } from "../lib/vault/binding-write-mark.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { assertProjectAccess } from "../lib/custom-agents/authz.js";
import { workspaceScopeWhere } from "../lib/auth/project-scope.js";
import {
  assertMcpCreateSecretBinding,
  assertMcpImportSecretBinding,
  assertMcpRebindSecretBinding,
  assertMcpUpdateSecretBinding,
} from "../lib/mcp/secret-binding.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorFromReq(req: Request) {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role };
}

/**
 * #305 — `/api/mcp` is mounted outside `/api/projects`, so the
 * `/projects/:id/:sub` chokepoint never reaches it. Every route here that acts
 * on a caller-supplied project id checks it through the canonical seam
 * (`assertProjectAccess`): admins bypass, a caller outside the project's
 * workspace gets the same 404 as an unknown id, and nothing is read or written.
 */
async function assertCallerProjectAccess(req: Request, projectId: string): Promise<void> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  await assertProjectAccess(req.user, projectId);
}

/**
 * #305 — a create that binds a server to a project (`scope: "project"`) must
 * name a project the caller can reach. `mcp.manage` / `mcp.write` are role
 * permissions (coordinators hold them), not a grant over every workspace's
 * projects. Runs BEFORE any vault write so a refused request leaves nothing.
 *
 * #335 — and it must name one at all. A project server stored with no project
 * was offered to every project at runtime and, after #311, reachable by no
 * non-admin to stop or delete it. Absent, null and empty all answer 400.
 */
async function assertProjectScopedCreate(
  req: Request,
  scope: unknown,
  projectId: unknown,
): Promise<void> {
  if (scope !== "project") return;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new AppError(400, PROJECT_REQUIRED, PROJECT_REQUIRED_MESSAGE);
  }
  await assertCallerProjectAccess(req, projectId);
}

/**
 * #311 — resolve an existing server by id for a route that acts on it. A
 * `scope: "project"` server is reachable only by a caller who passes
 * `assertProjectAccess` for the server's own project (admins bypass); a
 * project server with no project is never reachable by a non-admin. Unknown,
 * soft-deleted and unreachable servers all answer this one 404, so a probe
 * cannot tell them apart. Global servers stay role-gated.
 *
 * #340 — a `scope: "user"` server is reachable only by its owner (admins
 * bypass); one with no owner is never reachable by a non-admin.
 */
async function assertServerAccess(req: Request, id: string): Promise<void> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  const notFound = () => new AppError(404, "NOT_FOUND", "MCP server not found");
  const server = await svc().get(id);
  if (!server) throw notFound();
  if (req.user.role === "admin") return;
  if (server.scope === "user") {
    if (!server.userId || server.userId !== req.user.userId) throw notFound();
    return;
  }
  if (server.scope !== "project") return;
  if (!server.projectId) throw notFound();
  try {
    await assertProjectAccess(req.user, server.projectId);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw notFound();
    throw err;
  }
}

/**
 * #311 — the unfiltered lists narrow project-scoped servers to the projects
 * the caller can reach (`workspaceScopeWhere`: empty for admins).
 */
function projectScopeOf(req: Request): Record<string, unknown> {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return workspaceScopeWhere(req.user);
}

/**
 * #340 — the unfiltered lists narrow user-scoped servers to the caller's own
 * (`undefined` for admins: no narrowing).
 */
function userScopeOwnerOf(req: Request): string | undefined {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.role === "admin" ? undefined : req.user.userId;
}

function rethrow(err: unknown): never {
  if (err instanceof MCPRegistryError) {
    throw new AppError(err.status, err.code, err.message);
  }
  throw err;
}

function svc(): MCPRegistryService {
  try {
    return getMCPRegistry();
  } catch {
    throw new AppError(503, "MCP_NOT_READY", "MCP subsystem is not initialised");
  }
}

/**
 * SEC-7: scan a record of strings for secret-shaped entries and replace any
 * plaintext with a `${vault:...}` ref. The plaintext is persisted to the
 * vault under a fresh, collision-free label (#258). Returns
 * the (possibly rewritten) record alongside the new ref map. Vault writes
 * happen in-place; on failure the entry is left as-is and an error is
 * recorded so the caller can decide whether to reject the request.
 */
async function vaultPlaintextSecrets(
  record: Record<string, string> | null | undefined,
  ctx: {
    label: string;
    field: "env" | "header";
    actorId: string;
    scope: "global" | "project";
    isSecretFn: (key: string, value: string) => boolean;
    /** #495 — receives the id of every secret created, so a failed write can withdraw it. */
    created?: string[];
    /** #577 — receives each created secret's ref body → id, so the write binds exactly it. */
    bound?: SecretBindings;
  },
): Promise<{ rewritten: Record<string, string> | null; refs: Record<string, string> }> {
  if (!record) return { rewritten: null, refs: {} };
  const out: Record<string, string> = {};
  const refs: Record<string, string> = {};
  const vault = getVaultService();
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== "string") continue;
    if (v.startsWith("${vault:")) {
      out[k] = v;
      continue;
    }
    if (!ctx.isSecretFn(k, v)) {
      out[k] = v;
      continue;
    }
    const slugLabel = ctx.label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    const slugKey = k
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    const fieldTag = ctx.field === "header" ? "header-" : "";
    // #258 — a label no earlier secret holds. Fixed by server label + key, it
    // was taken by the previous write of the same key, so updating a secret
    // value (PATCH), re-creating a deleted server, or using the same server
    // label in another project was refused on `Secret.name @unique`.
    const secretLabel = freshSecretLabel(`mcp-${slugLabel || "server"}-${fieldTag}${slugKey}`);
    try {
      const summary = await vault.create(secretLabel, v, ctx.scope, {
        description: `Auto-vaulted ${ctx.field} from /api/mcp direct write for ${ctx.label}`,
        createdById: ctx.actorId,
      });
      ctx.created?.push(summary.id);
      if (ctx.bound) ctx.bound[secretLabel] = summary.id;
      audit({
        actor: { id: ctx.actorId },
        action: "vault.write",
        target: { type: "secret", id: summary.id },
        metadata: {
          label: secretLabel,
          source: "mcp_direct_write",
          field: ctx.field,
          key: k,
        },
      });
      out[k] = `\${vault:${secretLabel}}`;
      refs[k] = secretLabel;
    } catch (err) {
      // Reject — persisting plaintext is never acceptable. The route handler
      // surfaces this as 400 SECRET_PLAINTEXT_REJECTED so the caller knows
      // to vault the value first.
      throw new AppError(
        400,
        "SECRET_PLAINTEXT_REJECTED",
        `Plaintext secret detected in ${ctx.field} '${k}' and could not be auto-vaulted: ${(err as Error).message}`,
      );
    }
  }
  return { rewritten: out, refs };
}

export function mcpRouter(): Router {
  const r = Router();

  // ── Global registry ─────────────────────────────────────────────────
  r.get("/", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const scope =
      req.query.scope === "global" || req.query.scope === "project" || req.query.scope === "user"
        ? req.query.scope
        : undefined;
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    if (projectId !== undefined) await assertCallerProjectAccess(req, projectId);
    const items = await svc().list({
      scope,
      projectId,
      projectScope: projectScopeOf(req),
      userScopeOwner: userScopeOwnerOf(req),
    });
    res.json(ok({ items }));
  });

  r.post("/", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const parsed = createMCPServerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid MCP server payload", {
        issues: parsed.error.flatten(),
      });
    }
    const actor = actorFromReq(req);
    await assertProjectScopedCreate(req, parsed.data.scope, parsed.data.projectId);
    // #344 — before any vault write, so a refused request leaves nothing.
    // #577 — and the write binds exactly the ids this check approved.
    const { bindings: bound, until } = await assertMcpCreateSecretBinding(
      { userId: actor.id, role: actor.role },
      parsed.data,
    );
    /** #574 — secrets this request vaults; withdrawn if the row is never written. */
    const created: string[] = [];
    /** #574 — set the moment the row is written: from then on it names the new secrets. */
    let landed = false;
    try {
      const requestedScope = parsed.data.scope ?? "global";
      // Vault has no `user` scope; user-scoped MCP secrets fold into global.
      const scope: "global" | "project" = requestedScope === "project" ? "project" : "global";
      const envResult = await vaultPlaintextSecrets(parsed.data.env, {
        label: parsed.data.label,
        field: "env",
        actorId: actor.id,
        scope,
        bound,
        created,
        isSecretFn: (k, v) => SECRET_KEY_PATTERN.test(k) || isSecretValue(v),
      });
      const headerResult = await vaultPlaintextSecrets(parsed.data.headers, {
        label: parsed.data.label,
        field: "header",
        actorId: actor.id,
        scope,
        bound,
        created,
        isSecretFn: (k, v) => isSecretHeaderName(k) || isSecretValue(v),
      });
      // #552 — the write must land inside the binding check's window. A
      // refusal here is inside the try with `landed` still false, so #574
      // withdraws whatever this request already auto-vaulted.
      assertBindingWriteWindowOpen(until);
      const server = await svc().create(
        {
          ...parsed.data,
          env: envResult.rewritten ?? parsed.data.env,
          envSecretRefs: {
            ...(parsed.data.envSecretRefs ?? {}),
            ...envResult.refs,
          },
          headers: headerResult.rewritten ?? parsed.data.headers,
        },
        actor,
        {
          secretBindings: bound,
          onLanded: () => {
            landed = true;
          },
        },
      );
      res.status(201).json(ok(server));
    } catch (err) {
      // #574 — a create refused after auto-vaulting (label taken, image
      // denied, quota reached, a later header failing to vault) leaves the
      // vaulted values belonging to no server, so they are withdrawn.
      if (!landed) {
        await withdrawCreatedSecrets(getVaultService(), created, {
          actorId: actor.id,
          resource: { type: "mcp_server" },
          // #592 review — a project-scope create's withdrawals carry its
          // project, as the importer's do.
          projectId: parsed.data.scope === "project" ? (parsed.data.projectId ?? null) : null,
          cause: err,
        });
      }
      rethrow(err);
    }
  });

  r.patch("/:id", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const parsed = updateMCPServerSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid MCP server payload", {
        issues: parsed.error.flatten(),
      });
    }
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    // #344 — before any vault write, so a refused request leaves nothing.
    const check = await assertMcpUpdateSecretBinding(
      { userId: actor.id, role: actor.role },
      String(req.params.id),
      parsed.data,
    );
    const checkedAt = check?.checkedAt ?? null;
    /** #577 — the ids the check approved, plus any secret this request vaults. */
    const bound = check?.bindings ?? undefined;
    /** #495 — secrets this request vaults; withdrawn if the write does not land. */
    const created: string[] = [];
    /** #495 — set the moment the row is written: from then on it names the new secrets. */
    let landed = false;
    try {
      const existing = await svc().get(String(req.params.id));
      if (!existing) throw new AppError(404, "NOT_FOUND", "MCP server not found");
      // #495 — a row that moved after the guard read it is refused before any
      // plaintext is vaulted; the conditional write still catches a later move.
      if (checkedAt === null || existing.updatedAt !== checkedAt.toISOString()) {
        throw mcpConcurrentUpdateError();
      }
      // Vault doesn't have a `user` scope yet — fold user-scoped MCPs into
      // the `global` vault namespace until per-user secrets ship.
      const scope: "global" | "project" = existing.scope === "project" ? "project" : "global";
      const labelForVault = parsed.data.label ?? existing.label;
      const incomingEnv = parsed.data.env ?? null;
      const envResult = incomingEnv
        ? await vaultPlaintextSecrets(incomingEnv, {
            label: labelForVault,
            field: "env",
            actorId: actor.id,
            scope,
            created,
            bound,
            isSecretFn: (k, v) => SECRET_KEY_PATTERN.test(k) || isSecretValue(v),
          })
        : { rewritten: parsed.data.env ?? null, refs: {} as Record<string, string> };
      const incomingHeaders = parsed.data.headers ?? null;
      const headerResult = incomingHeaders
        ? await vaultPlaintextSecrets(incomingHeaders, {
            label: labelForVault,
            field: "header",
            actorId: actor.id,
            scope,
            created,
            bound,
            isSecretFn: (k, v) => isSecretHeaderName(k) || isSecretValue(v),
          })
        : { rewritten: parsed.data.headers ?? null, refs: {} as Record<string, string> };
      const mergedRefs = {
        ...(existing.envSecretRefs ?? {}),
        ...(parsed.data.envSecretRefs ?? {}),
        ...envResult.refs,
      };
      // #552 — the write must land inside the binding check's window.
      assertBindingWriteWindowOpen(check?.until ?? null);
      const updated = await svc().update(
        String(req.params.id),
        {
          ...parsed.data,
          env: parsed.data.env === undefined ? undefined : envResult.rewritten,
          envSecretRefs:
            parsed.data.env === undefined && Object.keys(envResult.refs).length === 0
              ? parsed.data.envSecretRefs
              : mergedRefs,
          headers: parsed.data.headers === undefined ? undefined : headerResult.rewritten,
        },
        actor,
        checkedAt,
        () => {
          landed = true;
        },
        bound,
      );
      res.json(ok(updated));
    } catch (err) {
      // #495 — a write that did not land leaves the vaulted values belonging to
      // no server, so they are withdrawn. Once it has landed the row names
      // them, and withdrawing would leave the server's env unresolvable.
      if (!landed) {
        await withdrawCreatedSecrets(getVaultService(), created, {
          actorId: actor.id,
          resource: { type: "mcp_server", id: String(req.params.id) },
          cause: err,
        });
      }
      rethrow(err);
    }
  });

  // #537 — re-bind the vault references the #504 backfill flagged, under the
  // #344 rule for the acting user: they must have created each secret, or hold
  // `vault.reveal`. Nothing else about the server changes.
  r.post("/:id/rebind-secrets", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    const id = String(req.params.id);
    await assertServerAccess(req, id);
    const check = await assertMcpRebindSecretBinding({ userId: actor.id, role: actor.role }, id);
    try {
      // #552 — the write must land inside the binding check's window.
      assertBindingWriteWindowOpen(check?.until ?? null);
      res.json(ok(await svc().rebindSecrets(id, actor, check?.checkedAt ?? null, check?.bindings)));
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete("/:id", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    try {
      await svc().remove(String(req.params.id), actor);
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Lifecycle ───────────────────────────────────────────────────────
  r.post("/:id/start", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    try {
      const updated = await svc().start(String(req.params.id), actor);
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/stop", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    try {
      const updated = await svc().stop(String(req.params.id), actor);
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/restart", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    try {
      const updated = await svc().restart(String(req.params.id), actor);
      res.json(ok(updated));
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/:id/test", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    await assertServerAccess(req, String(req.params.id));
    try {
      const result = await svc().test(String(req.params.id), actor);
      res.json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── mcp.json importer ────────────────────────────────────────────────
  r.post("/import", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    const actor = actorFromReq(req);
    const body = (req.body ?? {}) as {
      mcpJson?: unknown;
      dryRun?: boolean;
      scope?: "global" | "project";
      projectId?: string | null;
      trustLevel?: "trusted" | "untrusted";
      labelPrefix?: string;
    };
    if (!body.mcpJson) {
      throw new AppError(400, "VALIDATION_ERROR", "mcpJson is required");
    }
    await assertProjectScopedCreate(req, body.scope, body.projectId);
    try {
      if (body.dryRun) {
        const plan = await buildImportPlan(body.mcpJson, {
          scope: body.scope,
          projectId: body.projectId ?? null,
          labelPrefix: body.labelPrefix,
        });
        audit({
          actor: { id: actor.id },
          action: "mcp.import.preview",
          target: { type: "mcp_server", id: "n/a" },
          metadata: { entries: plan.entries.length, secrets: plan.totalSecrets },
        });
        res.json(ok({ plan, dryRun: true, created: [], errors: [] }));
        return;
      }
      // #344 — every secret an entry references must be the caller's.
      // #577 — and each entry binds exactly the ids its check approved.
      const secretBindings = await assertMcpImportSecretBinding(
        { userId: actor.id, role: actor.role },
        await buildImportPlan(body.mcpJson, { labelPrefix: body.labelPrefix }),
      );
      const result = await executeImport(body.mcpJson, svc(), actor, {
        secretBindings,
        scope: body.scope,
        projectId: body.projectId ?? null,
        trustLevel: body.trustLevel,
        labelPrefix: body.labelPrefix,
      });
      res.status(importStatus(result)).json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Per-project allow-list ──────────────────────────────────────────
  r.get(
    "/projects/:projectId/allowlist",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      await assertCallerProjectAccess(req, String(req.params.projectId));
      const ids = await svc().getAllowList(String(req.params.projectId));
      res.json(ok({ items: ids }));
    },
  );

  r.put(
    "/projects/:projectId/allowlist",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      const actor = actorFromReq(req);
      await assertCallerProjectAccess(req, String(req.params.projectId));
      const ids = Array.isArray((req.body ?? {}).serverIds)
        ? ((req.body as { serverIds: unknown[] }).serverIds.filter(
            (v) => typeof v === "string",
          ) as string[])
        : [];
      const updated = await svc().setAllowList(String(req.params.projectId), ids, actor);
      res.json(ok({ items: updated }));
    },
  );

  r.get(
    "/projects/:projectId/available",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      await assertCallerProjectAccess(req, String(req.params.projectId));
      const items = await svc().listForProject(String(req.params.projectId));
      res.json(ok({ items }));
    },
  );

  // ── Epic #162 — Issue #98 — public registry browser ──────────────────
  r.get("/registry", requireAuth, requirePermission("mcp.read"), async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const category = typeof req.query.category === "string" ? req.query.category : undefined;
    const page = parseIntSafe(req.query.page, 1);
    const pageSize = parseIntSafe(req.query.pageSize, 25);
    try {
      const result = await fetchRegistry({ q, category, page, pageSize, allowEmptyOnError: true });
      res.json(ok(result));
    } catch (err) {
      throw new AppError(502, "REGISTRY_UNAVAILABLE", (err as Error).message);
    }
  });

  r.post("/registry/install", requireAuth, requirePermission("mcp.write"), async (req, res) => {
    const actor = actorFromReq(req);
    const body = (req.body ?? {}) as {
      registryServerId?: string;
      scope?: "global" | "project";
      projectId?: string | null;
      label?: string;
    };
    if (!body.registryServerId || typeof body.registryServerId !== "string") {
      throw new AppError(400, "VALIDATION_ERROR", "registryServerId is required");
    }
    await assertProjectScopedCreate(req, body.scope, body.projectId);
    const list = await fetchRegistry();
    const entry = list.servers.find((s) => s.id === body.registryServerId);
    if (!entry) throw new AppError(404, "NOT_FOUND", "Registry entry not found");
    const transport = (entry.install?.type ?? "stdio") as "stdio" | "http" | "sse";
    try {
      const created = await svc().create(
        {
          scope: body.scope ?? "global",
          projectId: body.scope === "project" ? (body.projectId ?? undefined) : undefined,
          label: body.label || entry.name,
          transport,
          runtime: "native",
          command: entry.install?.command,
          args: entry.install?.args,
          url: entry.install?.url,
          trustLevel: "untrusted",
          defaultToolRisk: "medium",
          healthCheckIntervalSec: 60,
          enabled: true,
          version: entry.version,
        },
        actor,
        { source: { kind: "catalog", catalogId: entry.id, version: entry.version } },
      );
      audit({
        actor: { id: actor.id },
        action: "mcp.registry.install",
        target: { type: "mcp_server", id: created.id },
        metadata: { registryServerId: entry.id, scope: created.scope },
      });
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Epic #195 — Federated MCP discovery (Smithery + Official mirror) ──
  // Search is read-only and available to anyone with `mcp.read`. Install
  // requires `mcp.write` AND honours the per-server allowlist + integrity
  // gates from PR #181 — federation is a discovery layer, not a bypass.
  r.get("/search", requireAuth, requirePermission("mcp.read"), async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const sourceParam = typeof req.query.source === "string" ? req.query.source : undefined;
    const source =
      sourceParam === "smithery" ||
      sourceParam === "official" ||
      sourceParam === "local" ||
      sourceParam === "federated"
        ? sourceParam
        : undefined;
    const page = parseIntSafe(req.query.page, 1);
    const pageSize = parseIntSafe(req.query.pageSize, 25);
    // "federated" is a UX shortcut for both external sources — translates to
    // searching every source EXCEPT the local mirror.
    if (source === "federated") {
      const result = await searchFederated({ q, page, pageSize });
      const filtered = result.entries.filter((e) => e.source !== "local");
      res.json(ok({ total: filtered.length, entries: filtered }));
      return;
    }
    const result = await searchFederated({
      q,
      page,
      pageSize,
      source: source as FederationSource | undefined,
    });
    res.json(ok(result));
  });

  r.post("/federation/refresh", requireAuth, requirePermission("mcp.write"), async (req, res) => {
    const sourceParam = typeof req.query.source === "string" ? req.query.source : undefined;
    const sources: FederationSource[] =
      sourceParam === "smithery" || sourceParam === "official"
        ? [sourceParam]
        : ["smithery", "official"];
    const results = [];
    for (const source of sources) {
      results.push(await refreshSource(source));
    }
    res.json(ok({ results }));
  });

  r.post("/federation/install", requireAuth, requirePermission("mcp.write"), async (req, res) => {
    const actor = actorFromReq(req);
    const body = (req.body ?? {}) as {
      entryId?: string;
      scope?: "global" | "project";
      projectId?: string | null;
      label?: string;
    };
    if (!body.entryId || typeof body.entryId !== "string") {
      throw new AppError(400, "VALIDATION_ERROR", "entryId is required");
    }
    await assertProjectScopedCreate(req, body.scope, body.projectId);
    const entry = await getEntryById(body.entryId);
    if (!entry) {
      throw new AppError(404, "NOT_FOUND", "Federation entry not found");
    }
    if (entry.source === "local") {
      throw new AppError(409, "ALREADY_INSTALLED", "Entry is already installed locally");
    }
    const manifest = entry.manifest as {
      type?: "stdio" | "http" | "sse";
      command?: string;
      args?: string[];
      url?: string;
    };
    const transport = (manifest.type ?? "stdio") as "stdio" | "http" | "sse";
    try {
      const created = await svc().create(
        {
          scope: body.scope ?? "global",
          projectId: body.scope === "project" ? (body.projectId ?? undefined) : undefined,
          label: body.label || entry.name,
          transport,
          runtime: "native",
          command: manifest.command,
          args: manifest.args,
          url: manifest.url,
          // Federated installs always start as untrusted — the integrity
          // baseline is captured on the first connect, not at install time.
          trustLevel: "untrusted",
          defaultToolRisk: "medium",
          healthCheckIntervalSec: 60,
          enabled: true,
          version: entry.version ?? undefined,
        },
        actor,
        {
          source: {
            kind: "federation",
            catalogId: entry.externalId,
            version: entry.version ?? undefined,
          },
        },
      );
      await recordLocalInstall({
        externalId: entry.externalId,
        name: entry.name,
        manifest: entry.manifest,
        metadata: entry.metadata,
      });
      audit({
        actor: { id: actor.id },
        action: "mcp.federated.install.approved",
        target: { type: "mcp_server", id: created.id },
        metadata: {
          source: entry.source,
          externalId: entry.externalId,
          sha256: entry.sha256,
        },
      });
      res.status(201).json(ok(created));
    } catch (err) {
      rethrow(err);
    }
  });

  // ── Epic #162 — Issue #99 — inline tool tester ────────────────────────
  r.get("/servers/:id/tools", requireAuth, requirePermission("mcp.read"), async (req, res) => {
    await assertServerAccess(req, String(req.params.id));
    const view = await svc().get(String(req.params.id));
    if (!view) throw new AppError(404, "NOT_FOUND", "MCP server not found");
    res.json(ok({ tools: view.capabilities }));
  });

  r.post(
    "/servers/:id/tools/:tool/test",
    requireAuth,
    requirePermission("mcp.write"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const id = String(req.params.id);
      const toolName = String(req.params.tool);
      await assertServerAccess(req, id);
      const view = await svc().get(id);
      if (!view) throw new AppError(404, "NOT_FOUND", "MCP server not found");
      // Enforce per-server allowlist for the tester too — operators who lock
      // a server down must not be able to bypass it via the inline tester.
      if (
        view.toolAllowlist &&
        view.toolAllowlist.length > 0 &&
        !view.toolAllowlist.includes(toolName)
      ) {
        throw new AppError(403, "TOOL_DENIED", "Tool is not on the server allowlist");
      }
      const args = (req.body ?? {}).args ?? {};
      const start = Date.now();
      try {
        // Ensure the server is started before we invoke.
        await svc().test(id, actor);
        const result = await invokeTool(id, toolName, args);
        const durationMs = Date.now() - start;
        audit({
          actor: { id: actor.id },
          action: "mcp.tool.test",
          target: { type: "mcp_server", id },
          metadata: { tool: toolName, durationMs, isError: result.isError },
        });
        res.json(
          ok({
            result: result.content,
            isError: result.isError,
            durationMs,
          }),
        );
      } catch (err) {
        const durationMs = Date.now() - start;
        res.json(
          ok({
            result: null,
            isError: true,
            durationMs,
            error: (err as Error).message,
          }),
        );
      }
    },
  );

  // ── Epic #162 — Issue #105 — server integrity (snapshot diff) ─────────
  r.get(
    "/servers/:id/integrity/diff",
    requireAuth,
    requirePermission("mcp.read"),
    async (req, res) => {
      const id = String(req.params.id);
      await assertServerAccess(req, id);
      const view = await svc().get(id);
      if (!view) throw new AppError(404, "NOT_FOUND", "MCP server not found");
      const approved = await svc().getApprovedSnapshot(id);
      const current = snapshotToolSchemas(view.capabilities);
      const diff = diffSchemas(approved.snapshot, current);
      res.json(
        ok({
          diff,
          approvedAt: approved.approvedAt ? approved.approvedAt.toISOString() : null,
          hasBaseline: approved.snapshot != null,
          version: view.version,
          sha256: view.sha256,
        }),
      );
    },
  );

  r.post(
    "/servers/:id/integrity/approve-snapshot",
    requireAuth,
    requirePermission("mcp.write"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const id = String(req.params.id);
      await assertServerAccess(req, id);
      const view = await svc().get(id);
      if (!view) throw new AppError(404, "NOT_FOUND", "MCP server not found");
      const snapshot = snapshotToolSchemas(view.capabilities);
      try {
        const updated = await svc().approveSnapshot(id, snapshot, actor);
        res.json(ok(updated));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ── Epic #162 — Issue #104 — governance + approval responses ─────────
  r.patch(
    "/servers/:id/governance",
    requireAuth,
    requirePermission("mcp.write"),
    async (req, res) => {
      const actor = actorFromReq(req);
      const id = String(req.params.id);
      await assertServerAccess(req, id);
      const body = (req.body ?? {}) as {
        toolAllowlist?: unknown;
        requireApproval?: unknown;
      };
      const input: { toolAllowlist?: string[] | null; requireApproval?: boolean } = {};
      if (body.toolAllowlist !== undefined) {
        if (body.toolAllowlist === null) input.toolAllowlist = null;
        else if (Array.isArray(body.toolAllowlist)) {
          input.toolAllowlist = body.toolAllowlist
            .filter((s): s is string => typeof s === "string" && s.length > 0)
            .slice(0, 256);
        } else {
          throw new AppError(400, "VALIDATION_ERROR", "toolAllowlist must be array or null");
        }
      }
      if (body.requireApproval !== undefined) {
        input.requireApproval = Boolean(body.requireApproval);
      }
      try {
        const updated = await svc().setGovernance(id, input, actor);
        res.json(ok(updated));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.post("/approvals/:id/decide", requireAuth, requirePermission("mcp.write"), async (req, res) => {
    const actor = actorFromReq(req);
    const id = String(req.params.id);
    const decision = (req.body ?? {}).decision;
    if (decision !== "approved" && decision !== "denied") {
      throw new AppError(400, "VALIDATION_ERROR", "decision must be approved|denied");
    }
    // #142 — only the owner of the chat session the approval was raised in
    // (who can still reach its project) may answer it, and only while it is
    // pending. `mcp.write` alone let ANY writer approve another user's call.
    const pendingRow = await prisma.mCPToolApproval.findFirst({
      where: { id, status: "pending" },
      select: { sessionId: true },
    });
    if (!pendingRow) throw new AppError(404, "NOT_FOUND", "No pending approval with that id");
    try {
      await loadAuthorizedSession(req.user, pendingRow.sessionId);
    } catch {
      throw new AppError(404, "NOT_FOUND", "No pending approval with that id");
    }
    const status = await decideApproval(id, decision, actor.id);
    audit({
      actor: { id: actor.id },
      action: "mcp.approval.decide",
      target: { type: "mcp_approval", id },
      metadata: { decision: status },
    });
    res.json(ok({ id, status }));
  });

  // ── Epic #162 — Issue #124 — Copilot mcp.json import / export ────────
  r.get("/export", requireAuth, requirePermission("mcp.read"), async (req, res) => {
    const items = await svc().list({
      projectScope: projectScopeOf(req),
      userScopeOwner: userScopeOwnerOf(req),
    });
    const payload = exportToCopilotMcpJson(items);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Disposition", "attachment; filename=mcp.json");
    res.send(JSON.stringify(payload, null, 2));
  });

  r.post("/import-copilot", requireAuth, requirePermission("mcp.write"), async (req, res) => {
    const actor = actorFromReq(req);
    const body = (req.body ?? {}) as {
      mcpJson?: unknown;
      dryRun?: boolean;
      scope?: "global" | "project";
      projectId?: string | null;
    };
    if (!body.mcpJson) {
      throw new AppError(400, "VALIDATION_ERROR", "mcpJson is required");
    }
    await assertProjectScopedCreate(req, body.scope, body.projectId);
    let parsed;
    try {
      parsed = parseCopilotMcpJson(body.mcpJson);
    } catch (err) {
      throw new AppError(400, "VALIDATION_ERROR", `Invalid mcp.json: ${(err as Error).message}`);
    }
    const wrapped = { servers: parsed.servers };
    try {
      if (body.dryRun) {
        const plan = await buildImportPlan(wrapped, {
          scope: body.scope,
          projectId: body.projectId ?? null,
        });
        res.json(ok({ plan, dryRun: true, created: [], errors: [] }));
        return;
      }
      // #344 — every secret an entry references must be the caller's.
      // #577 — and each entry binds exactly the ids its check approved.
      const secretBindings = await assertMcpImportSecretBinding(
        { userId: actor.id, role: actor.role },
        await buildImportPlan(wrapped),
      );
      const result = await executeImport(wrapped, svc(), actor, {
        secretBindings,
        scope: body.scope,
        projectId: body.projectId ?? null,
      });
      res.status(importStatus(result)).json(ok(result));
    } catch (err) {
      rethrow(err);
    }
  });

  // Hidden-char scanner exposed for the UI's "preview args" component.
  r.post("/scan-hidden-chars", requireAuth, requirePermission("mcp.read"), async (req, res) => {
    const text = typeof (req.body ?? {}).text === "string" ? (req.body.text as string) : "";
    if (text.length > 64 * 1024) {
      throw new AppError(413, "PAYLOAD_TOO_LARGE", "text exceeds 64KB cap");
    }
    res.json(ok({ ranges: scanForHiddenChars(text) }));
  });

  // ── Single-item lookup (must come AFTER all specific-name GET routes
  //    like /search, /registry, /export to avoid /:id shadowing them) ──
  r.get("/:id", requireAuth, requirePermission("mcp.manage"), async (req, res) => {
    await assertServerAccess(req, String(req.params.id));
    const item = await svc().get(String(req.params.id));
    if (!item) throw new AppError(404, "NOT_FOUND", "MCP server not found");
    res.json(ok(item));
  });

  return r;
}

/**
 * Helper for the inline tool tester. Reaches into the lifecycle manager via
 * the registry singleton — keeps the route file from importing lifecycle
 * internals directly.
 */
async function invokeTool(
  serverId: string,
  toolName: string,
  args: unknown,
): Promise<{ content: unknown; isError: boolean }> {
  return getMCPRegistry().invokeTool(serverId, toolName, args);
}

function parseIntSafe(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
