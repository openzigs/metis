/**
 * Bridge between the MCP lifecycle manager and the Phase 4 ToolRegistry.
 *
 * Each ready MCP server's tools are registered as `mcp:<server-label>:<tool>`
 * with a risk level derived from the server's trust level + per-tool
 * annotations:
 *
 *   - trustLevel = "untrusted" → ALWAYS `high` (forces approval per Phase 4 M4)
 *   - trustLevel = "trusted"   → tool's annotated risk (high if destructive,
 *                                otherwise the server's `defaultToolRisk`)
 *
 * Approvals can NEVER be bypassed for high-risk tools — the gate is enforced
 * by `ToolRegistry.invoke`. The audit log captures every invocation through
 * the standard tool registry path.
 */
import { z } from "zod";
import crypto from "node:crypto";
import type { MCPToolRisk } from "@metis/shared";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { getToolRegistry } from "../ai/tool-registry.js";
import { prisma } from "../prisma.js";
import type { ToolDefinition, ToolResult } from "../ai/types.js";
import type { MCPLifecycleManager } from "./lifecycle-manager.js";
import type { MCPRegistryService } from "./mcp-service.js";
import type { MCPStatusEvent } from "./types.js";
import { McpToolDeniedError, enforceAllowlist } from "./allowlist.js";
import { McpApprovalDeniedError, requestApproval } from "./approval.js";
import { diffSchemas, isDiffEmpty, snapshotToolSchemas } from "./integrity.js";
import { withExecuteToolSpan } from "../otel/genai-spans.js";

const log = createChildLogger("mcp-tool-bridge");

const TOOL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

export interface MCPToolBridgeOptions {
  /**
   * Filter — when set, only tools from server ids in this set are surfaced.
   * Used to enforce per-project allow-lists at registration time.
   */
  isAllowed?: (serverId: string) => boolean;
  /**
   * Epic #272 — wake-up hook invoked before every tool call. Used by the
   * cold-start strategy: when a k8s-sse Deployment has been scaled to zero
   * by the idle reaper, this hook scales it back to one and waits for ready.
   * Returns silently if the server doesn't need waking.
   */
  coldStartWakeup?: (serverId: string) => Promise<void>;
}

export class MCPToolBridge {
  /** Registered tool names per server id so we can clean up on stop. */
  private readonly registered = new Map<string, Set<string>>();

  constructor(
    private readonly lifecycle: MCPLifecycleManager,
    private readonly registry: MCPRegistryService,
    private readonly opts: MCPToolBridgeOptions = {},
  ) {}

  /** Hook into lifecycle status events — re-syncs tools on every transition. */
  attach(): () => void {
    return this.lifecycle.onStatus((event) => this.onStatusChange(event));
  }

  private onStatusChange(event: MCPStatusEvent): void {
    if (event.status === "ready") {
      this.syncServer(event.serverId);
    } else {
      this.unregisterServer(event.serverId);
    }
  }

  syncServer(serverId: string): void {
    if (this.opts.isAllowed && !this.opts.isAllowed(serverId)) {
      this.unregisterServer(serverId);
      return;
    }
    const snapshot = this.lifecycle.get(serverId);
    if (!snapshot) return;
    this.unregisterServer(serverId);
    const names = new Set<string>();
    const reg = getToolRegistry();
    for (const tool of snapshot.state.tools) {
      if (!TOOL_NAME_PATTERN.test(tool.name)) {
        log.warn("Skipping MCP tool with invalid name", {
          serverId,
          tool: tool.name.slice(0, 64),
        });
        continue;
      }
      const fqName = formatToolName(snapshot.config.label, tool.name);
      const risk = resolveRisk(snapshot.config.trustLevel, tool.risk);
      const def = this.buildToolDefinition(
        serverId,
        snapshot.config.label,
        tool.name,
        fqName,
        risk,
      );
      try {
        reg.register(def);
        names.add(fqName);
      } catch (err) {
        log.warn("Failed to register MCP tool with registry", {
          fqName,
          error: (err as Error).message,
        });
      }
    }
    this.registered.set(serverId, names);
  }

  unregisterServer(serverId: string): void {
    const names = this.registered.get(serverId);
    if (!names) return;
    const reg = getToolRegistry();
    for (const name of names) reg.unregister(name);
    this.registered.delete(serverId);
  }

  /** Detach from lifecycle and unregister all surfaced tools. */
  shutdown(): void {
    for (const id of [...this.registered.keys()]) this.unregisterServer(id);
  }

  /** Useful for tests + introspection. */
  registeredFor(serverId: string): string[] {
    return [...(this.registered.get(serverId) ?? [])];
  }

  /** Test/introspection accessor — non-null when bootstrap wired a wake hook. */
  getColdStartWakeup(): ((serverId: string) => Promise<void>) | undefined {
    return this.opts.coldStartWakeup;
  }

  private buildToolDefinition(
    serverId: string,
    label: string,
    toolName: string,
    fqName: string,
    risk: MCPToolRisk,
  ): ToolDefinition<z.ZodRecord<z.ZodString, z.ZodUnknown>> {
    const lifecycle = this.lifecycle;
    const registry = this.registry;
    const coldStartWakeup = this.opts.coldStartWakeup;
    return {
      name: fqName,
      description: `MCP tool ${toolName} from server ${label}`,
      risk,
      schema: z.record(z.unknown()),
      async exec(args, ctx): Promise<ToolResult> {
        const snapshot = lifecycle.get(serverId);
        if (!snapshot || snapshot.state.status !== "ready") {
          throw new Error(`MCP server ${label} is not ready`);
        }
        const config = snapshot.config;
        const argsHash = sha256OfCanonical(args);
        // SEC-6: project-scoped server may only be invoked by sessions
        // attached to the SAME project. Otherwise a session bound to project
        // B that guesses the FQ tool name could reach project A's server.
        if (config.scope === "project" && config.projectId && ctx.projectId !== config.projectId) {
          audit({
            actor: { id: ctx.userId },
            action: "mcp.tool.invoke",
            target: { type: "mcp_server", id: serverId },
            metadata: {
              tool: toolName,
              risk,
              projectId: ctx.projectId ?? null,
              sessionId: ctx.sessionId,
              isError: true,
              decision: "denied",
              denyReason: "cross_project_access",
              version: config.version ?? null,
              sha256: config.sha256 ?? null,
              argsHash,
              resultHash: null,
            },
          });
          throw new Error(
            `MCP server ${label} is project-scoped to ${config.projectId} — cross-project invocation denied`,
          );
        }
        // Project allow-list re-check at invoke time so a session bound to a
        // project can never reach a server it's not allowed to use, even if
        // the bridge accidentally registered the tool.
        if (ctx.projectId && config.scope === "global") {
          const allowed = await registry.getAllowList(ctx.projectId);
          if (!allowed.includes(serverId)) {
            audit({
              actor: { id: ctx.userId },
              action: "mcp.tool.invoke",
              target: { type: "mcp_server", id: serverId },
              metadata: {
                tool: toolName,
                risk,
                projectId: ctx.projectId,
                sessionId: ctx.sessionId,
                isError: true,
                decision: "denied",
                denyReason: "not_on_allow_list",
                version: config.version ?? null,
                sha256: config.sha256 ?? null,
                argsHash,
                resultHash: null,
              },
            });
            throw new Error(`MCP server ${label} is not on the allow-list for this project`);
          }
        }
        // Epic #162 — per-tool allowlist + integrity diff + approval gate.
        // Optional surface on the registry — gracefully degrade for callers
        // that don't expose governance (e.g., test fakes).
        try {
          const readGov = (
            registry as unknown as {
              readGovernance?: (id: string) => Promise<{
                allowlist?: string[] | null;
                requireApproval?: boolean;
              } | null>;
            }
          ).readGovernance;
          const governance =
            typeof readGov === "function" ? await readGov.call(registry, serverId) : null;
          enforceAllowlist(serverId, toolName, governance?.allowlist ?? null);
          const getApprovedSnapshot = (
            registry as unknown as {
              getApprovedSnapshot?: (id: string) => Promise<{
                snapshot: ReturnType<typeof snapshotToolSchemas> | null;
              }>;
            }
          ).getApprovedSnapshot;
          const approved =
            typeof getApprovedSnapshot === "function"
              ? await getApprovedSnapshot.call(registry, serverId)
              : { snapshot: null };
          if (approved.snapshot) {
            const current = snapshotToolSchemas(snapshot.state.tools);
            const diff = diffSchemas(approved.snapshot, current);
            if (!isDiffEmpty(diff)) {
              throw new McpToolDeniedError(
                serverId,
                toolName,
                "schema_drift",
                `MCP server ${label} tool schema has drifted from the approved snapshot ` +
                  `(added=${diff.added.length}, removed=${diff.removed.length}, changed=${diff.changed.length}); ` +
                  `re-approve via /api/mcp/servers/${serverId}/integrity/approve-snapshot`,
              );
            }
          }
          if (governance?.requireApproval) {
            await requestApproval({
              sessionId: ctx.sessionId,
              serverId,
              serverLabel: label,
              toolName,
              args,
              risk,
            });
          }
        } catch (err) {
          if (err instanceof McpToolDeniedError || err instanceof McpApprovalDeniedError) {
            audit({
              actor: { id: ctx.userId },
              action: "mcp.tool.invoke",
              target: { type: "mcp_server", id: serverId },
              metadata: {
                tool: toolName,
                risk,
                projectId: ctx.projectId ?? null,
                sessionId: ctx.sessionId,
                isError: true,
                decision: "denied",
                denyReason:
                  err instanceof McpApprovalDeniedError ? `approval_${err.reason}` : err.reason,
                version: config.version ?? null,
                sha256: config.sha256 ?? null,
                argsHash,
                resultHash: null,
              },
            });
            return { text: JSON.stringify({ error: err.code, reason: err.reason }), isError: true };
          }
          throw err;
        }
        const result = await invokeOnLifecycle(
          lifecycle,
          serverId,
          toolName,
          args,
          coldStartWakeup,
        );
        // Issue #277 — best-effort touch of `lastToolInvocationAt` so the
        // idle reaper knows this user-scoped MCP is still in use. Failures
        // are non-fatal (e.g. row deleted mid-flight) so we swallow.
        prisma.mCPServer
          .updateMany({
            where: { id: serverId, deletedAt: null },
            data: { lastToolInvocationAt: new Date() },
          })
          .catch(() => undefined);
        // SEC-8 / R-E5: audit metadata MUST carry version, sha256, argsHash,
        // resultHash, and an explicit decision so audit consumers can prove
        // exactly which config + inputs produced an output.
        audit({
          actor: { id: ctx.userId },
          action: "mcp.tool.invoke",
          target: { type: "mcp_server", id: serverId },
          metadata: {
            tool: toolName,
            risk,
            projectId: ctx.projectId ?? null,
            sessionId: ctx.sessionId,
            isError: result.isError,
            decision: result.isError ? "error" : "allowed",
            version: config.version ?? null,
            sha256: config.sha256 ?? null,
            argsHash,
            resultHash: sha256OfCanonical(result),
          },
        });
        return result;
      },
    };
  }
}

/**
 * Compute the canonical tool name. Server labels are slugified so the
 * resulting name passes the registry's validator.
 */
export function formatToolName(label: string, tool: string): string {
  const safeLabel = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return `mcp:${safeLabel}:${tool}`.slice(0, 200);
}

/** Resolve effective risk based on server trust level and per-tool risk. */
export function resolveRisk(trust: "trusted" | "untrusted", perTool: MCPToolRisk): MCPToolRisk {
  if (trust === "untrusted") return "high";
  return perTool;
}

/**
 * Stable SHA-256 hash of arbitrary JSON-serialisable input. Object keys are
 * sorted recursively so semantically-equivalent payloads hash identically —
 * this is what makes the audit hashes useful for replay/comparison.
 */
export function sha256OfCanonical(value: unknown): string {
  return crypto.createHash("sha256").update(canonicalize(value)).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${canonicalize((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

async function invokeOnLifecycle(
  lifecycle: MCPLifecycleManager,
  serverId: string,
  toolName: string,
  args: unknown,
  coldStartWakeup?: (serverId: string) => Promise<void>,
): Promise<ToolResult> {
  return withExecuteToolSpan(serverId, toolName, async () => {
    // Reach into the lifecycle's runtime entry to invoke the tool. We can't go
    // through `transport.request` directly here without exposing internals, so
    // we use a thin invoke helper on the lifecycle.
    const snapshot = lifecycle.get(serverId);
    if (!snapshot) throw new Error(`MCP server ${serverId} not found`);
    // Epic #272 — wake a cold-started k8s-sse Deployment before delegating.
    // The hook is responsible for deciding whether wake-up is needed (no-op
    // for non-k8s-sse / non-cold-start / already-ready servers).
    if (coldStartWakeup) {
      try {
        await coldStartWakeup(serverId);
      } catch (err) {
        log.warn("Cold-start wake-up hook failed; proceeding with invoke", {
          serverId,
          error: (err as Error).message,
        });
      }
    }
    const result = await callToolViaLifecycle(lifecycle, serverId, toolName, args);
    return {
      text: typeof result.content === "string" ? result.content : JSON.stringify(result.content),
      isError: result.isError,
    };
  });
}

// Lifecycle exposes a getter with the live entries. We add a lightweight
// public helper here to avoid exporting more surface from lifecycle-manager.
async function callToolViaLifecycle(
  lifecycle: MCPLifecycleManager,
  serverId: string,
  toolName: string,
  args: unknown,
): Promise<{ content: unknown; isError: boolean }> {
  // Keep cast to a minimal interface — anything more would couple this file
  // to manager internals. The lifecycle manager exposes `invokeTool` at
  // runtime via a side-channel attached below.
  const fn = (
    lifecycle as unknown as {
      invokeTool?: (
        id: string,
        name: string,
        args: unknown,
      ) => Promise<{ content: unknown; isError: boolean }>;
    }
  ).invokeTool;
  if (!fn) throw new Error("lifecycle manager does not expose invokeTool");
  return fn.call(lifecycle, serverId, toolName, args);
}
