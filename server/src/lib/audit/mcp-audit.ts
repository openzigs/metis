/**
 * Issue #278 — Structured audit telemetry for MCP register/start/stop events.
 *
 * Wraps the generic `audit()` helper to enforce a consistent payload shape
 * across every MCP lifecycle transition and CRUD mutation. Sensitive env
 * values NEVER leave this helper — only env *keys* are recorded.
 *
 * Event kinds:
 *   - `mcp.registered`   — new row created
 *   - `mcp.updated`      — existing row mutated
 *   - `mcp.started`      — lifecycle reached `ready`
 *   - `mcp.stopped`      — lifecycle returned to `idle`
 *   - `mcp.start_failed` — connect threw or health probe failed at start
 */
import { audit } from "./audit-service.js";

export type McpAuditKind =
  | "mcp.registered"
  | "mcp.updated"
  | "mcp.started"
  | "mcp.stopped"
  | "mcp.start_failed";

export interface McpAuditContext {
  mcpId: string;
  name: string;
  scope: string;
  runtime?: string | null;
  image?: string | null;
  transport?: string | null;
  actor: { type: "user" | "system"; id: string | null };
  containerOrPodId?: string | null;
  command?: string | null;
  argsCount?: number;
  envKeys?: readonly string[];
  /** For `mcp.start_failed` only — redacted error message. */
  errorMessage?: string | null;
  exitCode?: number | null;
  /** Optional extra metadata, redacted by audit-service before persist. */
  extra?: Record<string, unknown>;
}

/**
 * Emit a structured audit row for an MCP lifecycle/registration event.
 *
 * The payload is shape-stable so downstream queries (`SELECT … WHERE
 * action='mcp.started'`) can rely on the metadata keys.
 */
export function auditMcpEvent(kind: McpAuditKind, ctx: McpAuditContext): void {
  const metadata: Record<string, unknown> = {
    name: ctx.name,
    scope: ctx.scope,
    runtime: ctx.runtime ?? null,
    image: ctx.image ?? null,
    transport: ctx.transport ?? null,
    actor: { type: ctx.actor.type, id: ctx.actor.id ?? null },
    containerOrPodId: ctx.containerOrPodId ?? null,
    command: ctx.command ?? null,
    argsCount: ctx.argsCount ?? 0,
    envKeys: ctx.envKeys ? [...ctx.envKeys] : [],
  };
  if (kind === "mcp.start_failed") {
    metadata.errorMessage = ctx.errorMessage ?? null;
    metadata.exitCode = ctx.exitCode ?? null;
  }
  if (ctx.extra) {
    for (const [k, v] of Object.entries(ctx.extra)) {
      if (!(k in metadata)) metadata[k] = v;
    }
  }
  audit({
    actor: ctx.actor.id,
    action: kind,
    target: { type: "mcp_server", id: ctx.mcpId },
    metadata,
  });
}
