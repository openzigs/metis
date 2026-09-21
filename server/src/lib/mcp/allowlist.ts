/**
 * Issue #104 — per-server tool allowlist enforcement.
 *
 * The list lives on `MCPServer.toolAllowlist` as JSON-encoded `string[]`
 * (SQLite — Postgres uses a native `String[]`). A `null` or empty list means
 * "all tools allowed" (default) so existing servers keep working until an
 * operator opts in to a restrictive policy.
 *
 * `enforceAllowlist` throws `McpToolDeniedError` so the agent receives a
 * structured `{ error: 'tool_denied', reason: 'not_on_allowlist' }` payload
 * instead of a generic exception.
 */

export class McpToolDeniedError extends Error {
  readonly code = "tool_denied";
  readonly reason: string;
  readonly serverId: string;
  readonly toolName: string;
  constructor(serverId: string, toolName: string, reason: string, message?: string) {
    super(message ?? `MCP tool ${toolName} denied: ${reason}`);
    this.name = "McpToolDeniedError";
    this.serverId = serverId;
    this.toolName = toolName;
    this.reason = reason;
  }
}

export function parseAllowlist(raw: string | string[] | null | undefined): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw.length === 0 ? null : raw.map(String);
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const list = parsed.map(String).filter(Boolean);
        return list.length === 0 ? null : list;
      }
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeAllowlist(list: string[] | null): string | null {
  if (!list || list.length === 0) return null;
  return JSON.stringify([...new Set(list.filter(Boolean))]);
}

export function isAllowed(allowlist: string[] | null, toolName: string): boolean {
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(toolName);
}

export function enforceAllowlist(
  serverId: string,
  toolName: string,
  allowlist: string[] | null,
): void {
  if (!isAllowed(allowlist, toolName)) {
    throw new McpToolDeniedError(serverId, toolName, "not_on_allowlist");
  }
}
