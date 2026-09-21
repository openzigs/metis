/**
 * MCP Registry Service — Phase 6.
 *
 * Persists MCPServer rows (with vault-only secrets), exposes CRUD for the
 * routes layer, and bridges the lifecycle manager so the in-memory client
 * pool reflects DB changes.
 *
 * Plaintext secrets NEVER cross the API boundary in either direction:
 *   - On write, env values matching `${vault:label}` are stored as-is. Plain
 *     values are stored verbatim (admin's choice — the importer routes
 *     secret-keyed names to the vault automatically; see `mcp-importer.ts`).
 *   - On read, the response always returns env values with secret values
 *     masked as `***` (only the secret label is exposed).
 */
import type {
  CreateMCPServerInput,
  MCPRuntime,
  MCPStatus,
  MCPToolDescriptor,
  MCPTransport,
  MCPTrustLevel,
  UpdateMCPServerInput,
} from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { auditMcpEvent } from "../audit/mcp-audit.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { expandVaultRefs } from "../vault/env-manager.js";
import { getVaultService } from "../vault/vault-service.js";
import type { MCPLifecycleManager } from "./lifecycle-manager.js";
import { MCPRegistryError } from "./mcp-service-error.js";
import type { MCPServerConfig } from "./types.js";
import {
  assertCuratedSource,
  assertImageAllowed,
  assertImageNotDenied,
  assertTrustPromotionAllowed,
  assertUserScopeAllowed,
  assertVaultEnv,
  type RegistrationSource,
} from "./validation.js";

export { MCPRegistryError };

const log = createChildLogger("mcp-service");

const VAULT_REF = /^\$\{vault:[^}]+\}$/;
const IMAGE_REF_RE =
  /^(?:[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?(?::[0-9]+)?\/)?[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?(?:\/[a-z0-9]+(?:(?:[._-][a-z0-9]+)+)?)*(?::[A-Za-z0-9_.-]+|@[A-Za-z0-9_+.-]+:[A-Za-z0-9=_+.-]+)?$/;

// Public wire shape for an MCP server row. Mirrors the prisma model but env
// values are masked + capabilities decoded.
export interface MCPServerView {
  id: string;
  scope: "global" | "project" | "user";
  projectId: string | null;
  /** Owning user id when `scope === 'user'`; null otherwise. (#277) */
  userId: string | null;
  label: string;
  transport: MCPTransport;
  /** Epic #271 — execution runtime (`native` | `docker-stdio` | `k8s-sse`). */
  runtime: MCPRuntime;
  command: string | null;
  args: string[] | null;
  url: string | null;
  headers: Record<string, string> | null;
  /** env values are NEVER plaintext — `${vault:...}` refs returned, plain values masked. */
  env: Record<string, string> | null;
  envSecretRefs: Record<string, string> | null;
  trustLevel: MCPTrustLevel;
  defaultToolRisk: "low" | "medium" | "high";
  version: string | null;
  sha256: string | null;
  // Epic #162 — governance + integrity (Issues #104, #105).
  toolAllowlist: string[] | null;
  requireApproval: boolean;
  toolSchemaApprovedAt: string | null;
  hasApprovedSchemaSnapshot: boolean;
  status: MCPStatus;
  lastHealthCheckAt: string | null;
  latencyMs: number | null;
  failureCount: number;
  lastError: string | null;
  healthCheckIntervalSec: number;
  enabled: boolean;
  /** Epic #272 — k8s-sse per-server overrides. */
  egressAllowlist: string | null;
  k8sMemoryLimit: string | null;
  k8sCpuLimit: string | null;
  coldStart: boolean;
  capabilities: MCPToolDescriptor[];
  createdAt: string;
  updatedAt: string;
}

interface ActorLite {
  id: string;
  role?: import("@metis/shared").RoleKey;
}

export interface CreateMCPOptions {
  /** Curated registration source — required when MCP_REQUIRE_CATALOG is on. */
  source?: RegistrationSource | null;
}

export function normalizeRuntimeForConfig(input: {
  runtime: MCPRuntime | null;
  transport: MCPTransport;
  command: string | null;
}): MCPRuntime {
  if (input.runtime && input.runtime !== "native") return input.runtime;
  if (input.transport !== "stdio" || !input.command) return input.runtime ?? "native";
  const command = input.command.trim();
  if (looksLikeContainerImageRef(command)) return "docker-stdio";
  return input.runtime ?? "native";
}

function looksLikeContainerImageRef(command: string): boolean {
  if (!command.includes("/") && !command.startsWith("localhost:")) return false;
  if (command.includes("://") || command.includes(" ")) return false;
  return IMAGE_REF_RE.test(command.toLowerCase());
}

export class MCPRegistryService {
  /**
   * Issue #315 (OWASP A04) — single-flight lock keyed by `userId` to close
   * the TOCTOU window between the per-user concurrency-cap count and the
   * subsequent `prisma.mCPServer.create()`. Each new user-scope create()
   * chains onto the previous in-flight promise so two concurrent requests
   * are serialized at the JS layer; the inner `$transaction` provides the
   * DB-side guarantee. Map entries are deleted as soon as their promise
   * settles so the lock map can't grow unbounded.
   */
  private readonly userCreateLocks = new Map<string, Promise<unknown>>();

  constructor(private readonly lifecycle: MCPLifecycleManager) {}

  /** Internal — serialize an async fn against any in-flight call for the same user. */
  private async withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.userCreateLocks.get(userId) ?? Promise.resolve();
    // Run after `prev` regardless of outcome (we don't propagate prev's rejection).
    const result = prev.then(fn, fn);
    // Store a rejection-swallowed handle so subsequent chained calls aren't
    // poisoned by a failure here.
    const stored: Promise<unknown> = result.then(
      () => undefined,
      () => undefined,
    );
    this.userCreateLocks.set(userId, stored);
    try {
      return await result;
    } finally {
      if (this.userCreateLocks.get(userId) === stored) {
        this.userCreateLocks.delete(userId);
      }
    }
  }

  /**
   * Issue #99 — expose the lifecycle for the inline tool tester. Internal use
   * only; callers should NOT depend on lifecycle internals beyond `invokeTool`.
   */
  invokeTool(
    serverId: string,
    toolName: string,
    args: unknown,
  ): Promise<{ content: unknown; isError: boolean }> {
    return this.lifecycle.invokeTool(serverId, toolName, args);
  }

  /** List all non-deleted MCP servers. Optionally filter by scope/project. */
  async list(
    opts: {
      scope?: "global" | "project" | "user";
      projectId?: string;
      /** Filter to a specific user id; only meaningful when `scope: 'user'`. */
      userId?: string;
    } = {},
  ): Promise<MCPServerView[]> {
    const where: Record<string, unknown> = { deletedAt: null };
    if (opts.scope) where.scope = opts.scope;
    if (opts.projectId !== undefined) where.projectId = opts.projectId;
    if (opts.userId !== undefined) where.userId = opts.userId;
    const rows = await prisma.mCPServer.findMany({
      where,
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toView(r));
  }

  async get(id: string): Promise<MCPServerView | null> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    return this.toView(row);
  }

  async create(
    input: CreateMCPServerInput,
    actor: ActorLite,
    options: CreateMCPOptions = {},
  ): Promise<MCPServerView> {
    const scope = (input.scope ?? "global") as "global" | "project" | "user";
    // Sub-issue #273 — curated registration enforcement.
    assertCuratedSource(scope, options.source ?? null, actor);
    // Sub-issue #274 — vault-only env enforcement.
    assertVaultEnv(input.env ?? null);
    // Sub-issue #275 — image allowlist (only fires for `command === 'docker'`).
    assertImageAllowed({ command: input.command ?? null, args: input.args ?? null });
    // Sub-issue #392 — image denylist (defence-in-depth over allowlist).
    assertImageNotDenied(
      { command: input.command ?? null, args: input.args ?? null },
      { actorId: actor.id, source: "registration", serverLabel: input.label ?? null },
    );
    // Sub-issue #276 — admin-only trust promotion.
    assertTrustPromotionAllowed(input.trustLevel, actor);
    // Sub-issue #277 — user-scope feature flag + concurrency cap.
    assertUserScopeAllowed({ scope, actorUserId: actor.id });

    // Issue #315 (OWASP A04) — for user-scope creates, the count + create
    // pair MUST be atomic. Two layers of defence:
    //   1. JS-side per-user mutex (`withUserLock`) so concurrent calls in
    //      the same Node process can't both observe `active < cap`.
    //   2. DB-side `$transaction` so the count + create commit together —
    //      on Postgres/MySQL this also serializes against other replicas
    //      (sqlite already serializes writes globally).
    if (scope === "user") {
      return this.withUserLock(actor.id, () => this.createUserScopedAtomic(input, actor, options));
    }
    return this.createInternal(input, actor, options);
  }

  /**
   * User-scope create: count + cap-check + create wrapped in a single
   * `$transaction` so the read-modify-write is atomic with respect to other
   * concurrent transactions. Issue #315 (OWASP A04 / TOCTOU).
   */
  private async createUserScopedAtomic(
    input: CreateMCPServerInput,
    actor: ActorLite,
    options: CreateMCPOptions,
  ): Promise<MCPServerView> {
    const cfg = (await import("../config/config-service.js")).getConfigService();
    const cap = cfg.getNumber("MCP_USER_MAX_CONCURRENT", 3);
    const data = this.buildPersistencePayload(input, { actorId: actor.id });
    const row = await prisma.$transaction(async (tx) => {
      const active = await tx.mCPServer.count({
        where: { userId: actor.id, scope: "user", enabled: true, deletedAt: null },
      });
      if (active >= cap) {
        throw new MCPRegistryError(
          429,
          "USER_QUOTA_EXCEEDED",
          `Per-user MCP concurrency cap reached (${active}/${cap})`,
        );
      }
      const existing = await tx.mCPServer.findFirst({
        where: {
          scope: data.scope,
          projectId: data.projectId,
          label: data.label,
          deletedAt: null,
        },
      });
      if (existing) {
        throw new MCPRegistryError(409, "LABEL_TAKEN", `MCP label '${data.label}' already exists`);
      }
      return tx.mCPServer.create({
        data: { ...data, createdById: actor.id },
      });
    });
    auditMcpEvent("mcp.registered", {
      mcpId: row.id,
      name: row.label,
      scope: row.scope,
      transport: row.transport,
      runtime: null,
      image: extractImageFromArgs(row.command, row.args),
      actor: { type: "user", id: actor.id },
      command: row.command,
      argsCount: parseStringArray(row.args)?.length ?? 0,
      envKeys: collectEnvKeys(row.envJson),
      extra: options.source
        ? {
            source: {
              kind: options.source.kind,
              ...stripUndef(options.source as unknown as Record<string, unknown>),
            },
          }
        : undefined,
    });
    return this.toView(row);
  }

  /** Original non-user-scope create path (no concurrency cap to enforce). */
  private async createInternal(
    input: CreateMCPServerInput,
    actor: ActorLite,
    options: CreateMCPOptions,
  ): Promise<MCPServerView> {
    const data = this.buildPersistencePayload(input, { actorId: actor.id });
    const existing = await prisma.mCPServer.findFirst({
      where: {
        scope: data.scope,
        projectId: data.projectId,
        label: data.label,
        deletedAt: null,
      },
    });
    if (existing) {
      throw new MCPRegistryError(409, "LABEL_TAKEN", `MCP label '${data.label}' already exists`);
    }
    const row = await prisma.mCPServer.create({
      data: {
        ...data,
        createdById: actor.id,
      },
    });
    auditMcpEvent("mcp.registered", {
      mcpId: row.id,
      name: row.label,
      scope: row.scope,
      transport: row.transport,
      runtime: null,
      image: extractImageFromArgs(row.command, row.args),
      actor: { type: "user", id: actor.id },
      command: row.command,
      argsCount: parseStringArray(row.args)?.length ?? 0,
      envKeys: collectEnvKeys(row.envJson),
      extra: options.source
        ? {
            source: {
              kind: options.source.kind,
              ...stripUndef(options.source as unknown as Record<string, unknown>),
            },
          }
        : undefined,
    });
    return this.toView(row);
  }

  async update(id: string, input: UpdateMCPServerInput, actor: ActorLite): Promise<MCPServerView> {
    const existing = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    }
    // Sub-issue #274 — vault-only env enforcement on updates too.
    if (input.env !== undefined && input.env !== null) {
      assertVaultEnv(input.env);
    }
    // Sub-issue #275 — image allowlist on updates (when command/args change).
    const nextCommand = input.command !== undefined ? input.command : existing.command;
    const nextArgsRaw =
      input.args !== undefined ? input.args : (parseStringArray(existing.args) as string[] | null);
    assertImageAllowed({
      command: nextCommand ?? null,
      args: (nextArgsRaw as string[] | null) ?? null,
    });
    // Sub-issue #392 — image denylist on updates too.
    assertImageNotDenied(
      {
        command: nextCommand ?? null,
        args: (nextArgsRaw as string[] | null) ?? null,
      },
      { actorId: actor.id, source: "registration", serverId: id, serverLabel: existing.label },
    );
    // Sub-issue #276 — admin-only trust promotion on updates.
    assertTrustPromotionAllowed(input.trustLevel, actor);
    const data = this.buildUpdatePayload(input);
    const row = await prisma.mCPServer.update({ where: { id }, data });
    auditMcpEvent("mcp.updated", {
      mcpId: row.id,
      name: row.label,
      scope: row.scope,
      transport: row.transport,
      runtime: null,
      image: extractImageFromArgs(row.command, row.args),
      actor: { type: "user", id: actor.id },
      command: row.command,
      argsCount: parseStringArray(row.args)?.length ?? 0,
      envKeys: collectEnvKeys(row.envJson),
      extra: { changed: Object.keys(input) },
    });
    return this.toView(row);
  }

  async remove(id: string, actor: ActorLite): Promise<void> {
    const existing = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) {
      throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    }
    await this.lifecycle.stop(id, "delete");
    await prisma.mCPServer.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false, status: "disabled" },
    });
    audit({
      actor: { id: actor.id },
      action: "mcp.delete",
      target: { type: "mcp_server", id },
      metadata: { label: existing.label },
    });
  }

  async start(id: string, actor: ActorLite): Promise<MCPServerView> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const config = this.toConfig(row);
    const state = await this.lifecycle.start(config);
    const updated = await prisma.mCPServer.update({
      where: { id },
      data: {
        status: state.status,
        lastError: state.lastError,
        latencyMs: state.latencyMs,
        failureCount: state.failureCount,
        lastHealthCheckAt: state.lastHealthCheckAt,
        capabilities: JSON.stringify(state.tools),
      },
    });
    if (state.status === "ready") {
      auditMcpEvent("mcp.started", {
        mcpId: id,
        name: updated.label,
        scope: updated.scope,
        transport: updated.transport,
        image: extractImageFromArgs(updated.command, updated.args),
        actor: { type: "user", id: actor.id },
        command: updated.command,
        argsCount: parseStringArray(updated.args)?.length ?? 0,
        envKeys: collectEnvKeys(updated.envJson),
      });
    } else {
      auditMcpEvent("mcp.start_failed", {
        mcpId: id,
        name: updated.label,
        scope: updated.scope,
        transport: updated.transport,
        image: extractImageFromArgs(updated.command, updated.args),
        actor: { type: "user", id: actor.id },
        command: updated.command,
        argsCount: parseStringArray(updated.args)?.length ?? 0,
        envKeys: collectEnvKeys(updated.envJson),
        errorMessage: state.lastError,
        extra: { status: state.status },
      });
    }
    return this.toView(updated);
  }

  async stop(id: string, actor: ActorLite): Promise<MCPServerView> {
    await this.lifecycle.stop(id, "manual");
    const updated = await prisma.mCPServer.update({
      where: { id },
      data: { status: "idle", capabilities: null },
    });
    auditMcpEvent("mcp.stopped", {
      mcpId: id,
      name: updated.label,
      scope: updated.scope,
      transport: updated.transport,
      image: extractImageFromArgs(updated.command, updated.args),
      actor: { type: "user", id: actor.id },
      command: updated.command,
      argsCount: parseStringArray(updated.args)?.length ?? 0,
      envKeys: collectEnvKeys(updated.envJson),
    });
    return this.toView(updated);
  }

  async restart(id: string, actor: ActorLite): Promise<MCPServerView> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const config = this.toConfig(row);
    await this.lifecycle.start(config); // ensures registered
    const state = await this.lifecycle.restart(id);
    const updated = await prisma.mCPServer.update({
      where: { id },
      data: {
        status: state.status,
        lastError: state.lastError,
        capabilities: JSON.stringify(state.tools),
      },
    });
    audit({
      actor: { id: actor.id },
      action: "mcp.restart",
      target: { type: "mcp_server", id },
      metadata: { status: state.status },
    });
    return this.toView(updated);
  }

  /**
   * One-shot probe + cache update. Used by both the CLI tester and the inline
   * "Test" button in the admin UI.
   */
  async test(
    id: string,
    actor: ActorLite,
  ): Promise<{
    ok: boolean;
    latencyMs: number;
    tools: MCPToolDescriptor[];
    error?: string;
  }> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const config = this.toConfig(row);
    await this.lifecycle.start(config);
    const probe = await this.lifecycle.probe(id);
    const snapshot = this.lifecycle.get(id);
    audit({
      actor: { id: actor.id },
      action: "mcp.test",
      target: { type: "mcp_server", id },
      metadata: { ok: probe.ok, latencyMs: probe.latencyMs },
    });
    return {
      ok: probe.ok,
      latencyMs: probe.latencyMs,
      tools: snapshot?.state.tools ?? [],
      error: probe.error,
    };
  }

  // ── Epic #162 — governance: per-tool allowlist + per-session approval ─

  async setGovernance(
    id: string,
    input: { toolAllowlist?: string[] | null; requireApproval?: boolean },
    actor: ActorLite,
  ): Promise<MCPServerView> {
    const existing = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const data: Record<string, unknown> = {};
    if (input.toolAllowlist !== undefined) {
      const list = input.toolAllowlist;
      data.toolAllowlist =
        list && list.length > 0
          ? JSON.stringify([...new Set(list.filter((s) => typeof s === "string" && s.length > 0))])
          : null;
    }
    if (input.requireApproval !== undefined) {
      data.requireApproval = Boolean(input.requireApproval);
    }
    if (Object.keys(data).length === 0) {
      return this.toView(existing);
    }
    const row = await prisma.mCPServer.update({ where: { id }, data });
    audit({
      actor: { id: actor.id },
      action: "mcp.governance.update",
      target: { type: "mcp_server", id: row.id },
      metadata: { changed: Object.keys(input) },
    });
    return this.toView(row);
  }

  async readGovernance(
    id: string,
  ): Promise<{ allowlist: string[] | null; requireApproval: boolean } | null> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) return null;
    return {
      allowlist: parseAllowlistFromRow((row as McpRow).toolAllowlist ?? null),
      requireApproval: Boolean((row as McpRow).requireApproval),
    };
  }

  async getApprovedSnapshot(id: string): Promise<{
    snapshot: Record<string, unknown> | null;
    approvedAt: Date | null;
  }> {
    const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const r = row as McpRow;
    if (!r.toolSchemaSnapshot) return { snapshot: null, approvedAt: null };
    try {
      const parsed = JSON.parse(r.toolSchemaSnapshot);
      if (parsed && typeof parsed === "object") {
        return {
          snapshot: parsed as Record<string, unknown>,
          approvedAt: r.toolSchemaApprovedAt ?? null,
        };
      }
    } catch {
      log.warn("Failed to parse tool schema snapshot JSON", { id });
    }
    return { snapshot: null, approvedAt: null };
  }

  async approveSnapshot(
    id: string,
    snapshot: Record<string, unknown>,
    actor: ActorLite,
  ): Promise<MCPServerView> {
    const existing = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new MCPRegistryError(404, "NOT_FOUND", `MCP server ${id} not found`);
    const row = await prisma.mCPServer.update({
      where: { id },
      data: {
        toolSchemaSnapshot: JSON.stringify(snapshot),
        toolSchemaApprovedAt: new Date(),
      },
    });
    audit({
      actor: { id: actor.id },
      action: "mcp.integrity.approve",
      target: { type: "mcp_server", id: row.id },
      metadata: { toolCount: Object.keys(snapshot).length },
    });
    return this.toView(row);
  }

  // ── Per-project allow-list ────────────────────────────────────────────

  async getAllowList(projectId: string): Promise<string[]> {
    const rows = await prisma.projectMCPAllowlist.findMany({
      where: { projectId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map((r) => r.mcpServerId);
  }

  async setAllowList(projectId: string, serverIds: string[], actor: ActorLite): Promise<string[]> {
    const unique = [...new Set(serverIds)];
    // Cascade delete + recreate is fine here; the table is small (per project).
    await prisma.projectMCPAllowlist.deleteMany({ where: { projectId } });
    if (unique.length > 0) {
      await prisma.projectMCPAllowlist.createMany({
        data: unique.map((mcpServerId) => ({ projectId, mcpServerId })),
      });
    }
    audit({
      actor: { id: actor.id },
      action: "mcp.allowlist.update",
      target: { type: "project", id: projectId },
      metadata: { count: unique.length },
    });
    return this.getAllowList(projectId);
  }

  /**
   * Resolve the set of MCP servers a project may use:
   *   - all `project`-scoped servers belonging to the project
   *   - global servers explicitly added to the project's allow-list
   */
  async listForProject(projectId: string): Promise<MCPServerView[]> {
    const [scoped, allowlist] = await Promise.all([
      prisma.mCPServer.findMany({
        where: { projectId, scope: "project", deletedAt: null },
      }),
      prisma.projectMCPAllowlist.findMany({
        where: { projectId },
        include: { mcpServer: true },
      }),
    ]);
    const allowedGlobals = allowlist
      .map((a) => a.mcpServer)
      .filter((s) => s && !s.deletedAt && s.scope === "global");
    return [...scoped, ...allowedGlobals].map((r) => this.toView(r));
  }

  // ── Internals ────────────────────────────────────────────────────────

  /**
   * Resolve the env map for a given server, expanding vault refs. Used by the
   * lifecycle manager and the CLI tester.
   */
  async resolveEnv(env: Record<string, string>): Promise<Record<string, string>> {
    if (!env || Object.keys(env).length === 0) return {};
    return expandVaultRefs(env, getVaultService());
  }

  toConfig(row: McpRow): MCPServerConfig {
    return {
      id: row.id,
      scope: row.scope as "global" | "project" | "user",
      projectId: row.projectId,
      label: row.label,
      transport: row.transport as MCPTransport,
      runtime: normalizeRuntimeForConfig({
        runtime: (row.runtime as MCPRuntime | null) ?? "native",
        transport: row.transport as MCPTransport,
        command: row.command,
      }),
      command: row.command,
      args: parseStringArray(row.args),
      url: row.url,
      headers: parseObject(row.headers),
      env: parseObject(row.envJson),
      envSecretRefs: parseObject(row.envSecretRefs),
      trustLevel: row.trustLevel as MCPTrustLevel,
      defaultToolRisk: row.defaultToolRisk as "low" | "medium" | "high",
      version: row.version,
      sha256: row.sha256,
      healthCheckIntervalSec: row.healthCheckIntervalSec,
      enabled: row.enabled,
      egressAllowlist: (row as McpRow).egressAllowlist ?? null,
      k8sMemoryLimit: (row as McpRow).k8sMemoryLimit ?? null,
      k8sCpuLimit: (row as McpRow).k8sCpuLimit ?? null,
      coldStart: Boolean((row as McpRow).coldStart ?? false),
    };
  }

  private buildPersistencePayload(input: CreateMCPServerInput, ctx: { actorId: string }) {
    const env = input.env ?? null;
    const scope = input.scope ?? "global";
    const runtime = input.runtime ?? "native";
    // Sub-issue #287 — k8s-sse runtime forces transport=sse. The MCP runs
    // inside the cluster behind a Service that always exposes SSE on :8080;
    // any other transport choice is a configuration error.
    let transport = input.transport;
    if (runtime === "k8s-sse" && transport !== "sse") {
      log.warn("k8s-sse runtime overrides client-supplied transport to 'sse'", {
        label: input.label,
        suppliedTransport: transport,
      });
      transport = "sse";
    }
    return {
      scope,
      projectId: scope === "project" ? (input.projectId ?? null) : null,
      // Sub-issue #277 — `userId` is set on user-scoped registrations.
      userId: scope === "user" ? ctx.actorId : null,
      label: input.label,
      transport,
      runtime,
      command: input.command ?? null,
      args: input.args ? JSON.stringify(input.args) : null,
      url: input.url ?? null,
      headers: input.headers ? JSON.stringify(input.headers) : null,
      envJson: env ? JSON.stringify(env) : null,
      envSecretRefs: input.envSecretRefs ? JSON.stringify(input.envSecretRefs) : null,
      trustLevel: input.trustLevel ?? "untrusted",
      defaultToolRisk: input.defaultToolRisk ?? "medium",
      version: input.version ?? null,
      sha256: input.sha256 ?? null,
      healthCheckIntervalSec: input.healthCheckIntervalSec ?? 60,
      enabled: input.enabled ?? true,
      status: "idle",
      capabilities: null,
      // Epic #272 — k8s-sse per-server overrides.
      egressAllowlist: input.egressAllowlist ?? null,
      k8sMemoryLimit: input.k8sMemoryLimit ?? null,
      k8sCpuLimit: input.k8sCpuLimit ?? null,
      coldStart: input.coldStart ?? false,
    };
  }

  private buildUpdatePayload(input: UpdateMCPServerInput) {
    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label;
    if (input.runtime !== undefined) {
      data.runtime = input.runtime;
      // Sub-issue #287 — same override as on create. We only force the
      // transport when the caller did NOT explicitly include one in this
      // patch; if they sent both, we override theirs and warn.
      if (input.runtime === "k8s-sse") {
        if ((input as { transport?: unknown }).transport !== undefined) {
          log.warn("k8s-sse runtime overrides client-supplied transport on update", {
            suppliedTransport: (input as { transport?: unknown }).transport,
          });
        }
        data.transport = "sse";
      }
    }
    if (input.command !== undefined) data.command = input.command;
    if (input.args !== undefined) data.args = input.args ? JSON.stringify(input.args) : null;
    if (input.url !== undefined) data.url = input.url;
    if (input.headers !== undefined)
      data.headers = input.headers ? JSON.stringify(input.headers) : null;
    if (input.env !== undefined) data.envJson = input.env ? JSON.stringify(input.env) : null;
    if (input.envSecretRefs !== undefined)
      data.envSecretRefs = input.envSecretRefs ? JSON.stringify(input.envSecretRefs) : null;
    if (input.trustLevel !== undefined) data.trustLevel = input.trustLevel;
    if (input.defaultToolRisk !== undefined) data.defaultToolRisk = input.defaultToolRisk;
    if (input.version !== undefined) data.version = input.version;
    if (input.sha256 !== undefined) data.sha256 = input.sha256;
    if (input.healthCheckIntervalSec !== undefined)
      data.healthCheckIntervalSec = input.healthCheckIntervalSec;
    if (input.enabled !== undefined) data.enabled = input.enabled;
    if (input.egressAllowlist !== undefined) data.egressAllowlist = input.egressAllowlist;
    if (input.k8sMemoryLimit !== undefined) data.k8sMemoryLimit = input.k8sMemoryLimit;
    if (input.k8sCpuLimit !== undefined) data.k8sCpuLimit = input.k8sCpuLimit;
    if (input.coldStart !== undefined) data.coldStart = input.coldStart;
    return data;
  }

  private toView(row: McpRow): MCPServerView {
    const env = parseObject<Record<string, string>>(row.envJson);
    const maskedEnv: Record<string, string> | null = env
      ? Object.fromEntries(
          Object.entries(env).map(([k, v]) => {
            if (typeof v !== "string") return [k, ""];
            // Vault refs are surfaced as-is so the UI can show the label;
            // anything else is masked. The plaintext NEVER leaves the server.
            return [k, VAULT_REF.test(v) ? v : "***"];
          }),
        )
      : null;
    // SEC-3: headers MUST be masked the same way as env. Bearer tokens,
    // API keys etc. used to be echoed back through this view path.
    const rawHeaders = parseObject<Record<string, string>>(row.headers);
    const maskedHeaders: Record<string, string> | null = rawHeaders
      ? Object.fromEntries(
          Object.entries(rawHeaders).map(([k, v]) => {
            if (typeof v !== "string") return [k, ""];
            return [k, VAULT_REF.test(v) ? v : "***"];
          }),
        )
      : null;
    const tools = parseObject<MCPToolDescriptor[]>(row.capabilities) ?? [];
    return {
      id: row.id,
      scope: row.scope as "global" | "project" | "user",
      projectId: row.projectId,
      userId: (row as McpRow).userId ?? null,
      label: row.label,
      transport: row.transport as MCPTransport,
      runtime: ((row as McpRow).runtime as MCPRuntime | null) ?? "native",
      command: row.command,
      args: parseStringArray(row.args),
      url: row.url,
      headers: maskedHeaders,
      env: maskedEnv,
      envSecretRefs: parseObject(row.envSecretRefs),
      trustLevel: row.trustLevel as MCPTrustLevel,
      defaultToolRisk: row.defaultToolRisk as "low" | "medium" | "high",
      version: row.version,
      sha256: row.sha256,
      toolAllowlist: parseAllowlistFromRow(row.toolAllowlist ?? null),
      requireApproval: Boolean(row.requireApproval),
      toolSchemaApprovedAt: row.toolSchemaApprovedAt
        ? row.toolSchemaApprovedAt.toISOString()
        : null,
      hasApprovedSchemaSnapshot: row.toolSchemaSnapshot != null && row.toolSchemaSnapshot !== "",
      status: (row.status as MCPStatus) ?? "idle",
      lastHealthCheckAt: row.lastHealthCheckAt ? row.lastHealthCheckAt.toISOString() : null,
      latencyMs: row.latencyMs,
      failureCount: row.failureCount,
      lastError: row.lastError,
      healthCheckIntervalSec: row.healthCheckIntervalSec,
      enabled: row.enabled,
      egressAllowlist: (row as McpRow).egressAllowlist ?? null,
      k8sMemoryLimit: (row as McpRow).k8sMemoryLimit ?? null,
      k8sCpuLimit: (row as McpRow).k8sCpuLimit ?? null,
      coldStart: Boolean((row as McpRow).coldStart ?? false),
      capabilities: tools,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

interface McpRow {
  id: string;
  scope: string;
  projectId: string | null;
  /** Sub-issue #277 — populated for user-scoped rows. */
  userId?: string | null;
  label: string;
  transport: string;
  /** Epic #271 — execution runtime; null on legacy rows pre-migration. */
  runtime?: string | null;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envJson: string | null;
  envSecretId: string | null;
  envSecretRefs: string | null;
  trustLevel: string;
  defaultToolRisk: string;
  version: string | null;
  sha256: string | null;
  toolSchemaSnapshot?: string | null;
  toolSchemaApprovedAt?: Date | null;
  toolAllowlist?: string | null;
  requireApproval?: boolean | null;
  capabilities: string | null;
  status: string;
  lastHealthCheckAt: Date | null;
  latencyMs: number | null;
  failureCount: number;
  lastError: string | null;
  healthCheckIntervalSec: number;
  enabled: boolean;
  /** Epic #272 — k8s-sse per-server overrides (null on legacy rows pre-migration). */
  egressAllowlist?: string | null;
  k8sMemoryLimit?: string | null;
  k8sCpuLimit?: string | null;
  coldStart?: boolean | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

function parseStringArray(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    log.warn("Failed to parse MCP args JSON", { length: json.length });
  }
  return null;
}

function parseObject<T = Record<string, string>>(json: string | null): T | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === "object") return parsed as T;
  } catch {
    log.warn("Failed to parse MCP JSON column", { length: json.length });
  }
  return null;
}

function parseAllowlistFromRow(raw: string | string[] | null | undefined): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.length > 0 ? raw.map(String) : null;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const list = parsed.map(String).filter(Boolean);
      return list.length === 0 ? null : list;
    }
  } catch {
    return null;
  }
  return null;
}

let singleton: MCPRegistryService | null = null;
export function setMCPRegistry(service: MCPRegistryService | null): void {
  singleton = service;
}
export function getMCPRegistry(): MCPRegistryService {
  if (!singleton) {
    throw new Error("MCP registry has not been initialised");
  }
  return singleton;
}

// ── Audit helpers (#278) ────────────────────────────────────────────────

/** Extract image hint from a `docker` argv for audit metadata. */
function extractImageFromArgs(command: string | null, argsJson: string | null): string | null {
  if (command !== "docker") return null;
  const args = parseStringArray(argsJson);
  if (!args) return null;
  // Reuse the simpler heuristic — the validator already canonicalised it.
  for (let i = args[0] === "run" ? 1 : 0; i < args.length; i += 1) {
    const tok = args[i];
    if (!tok.startsWith("-")) return tok;
  }
  return null;
}

/** Return the env-key list (no values) from the persisted JSON column. */
function collectEnvKeys(envJson: string | null): string[] {
  const parsed = parseObject<Record<string, unknown>>(envJson);
  return parsed ? Object.keys(parsed) : [];
}

/** Strip `undefined` properties from an object literal. */
function stripUndef<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
