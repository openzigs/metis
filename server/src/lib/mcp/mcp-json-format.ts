/**
 * Issue #124 — Copilot CLI `mcp.json` import / export.
 *
 * Export shape mirrors `~/.copilot/mcp.json`:
 *   { "servers": { "<label>": { "command", "args", "env", "type" } } }
 *
 * Env values that are vault refs (`${vault:label}`) are emitted as-is so a
 * round-trip preserves the indirection. PLAINTEXT secrets are NEVER written
 * to the export file — masked values (`***` from the read view) are dropped
 * because they would otherwise corrupt a re-import.
 *
 * Import re-uses the existing vault routing from #51: any env / header key
 * matching the secret pattern (case-insensitive `_TOKEN`, `_KEY`, `_PASSWORD`,
 * `_SECRET`, `_PAT`, etc.) is routed into the vault before the MCPServer row
 * is persisted. This file is a thin adapter on top of `mcp-importer.ts` so we
 * keep one source of truth for secret handling.
 */
import { copilotMcpJsonSchema, type CopilotMcpJson } from "@metis/shared";
import type { MCPServerView } from "./mcp-service.js";
import {
  buildImportPlan,
  executeImport,
  type ImportPlan,
  type ImportResult,
} from "./mcp-importer.js";
import type { MCPRegistryService } from "./mcp-service.js";

/**
 * The `${vault:...}` test is intentionally permissive: an entire value, OR a
 * value that contains a ref anywhere (e.g. `Bearer ${vault:foo}`), is treated
 * as a vault ref and exported verbatim.
 */
const VAULT_REF_RE = /\$\{vault:[^}]+\}/;

function isVaultRef(value: string): boolean {
  return VAULT_REF_RE.test(value);
}

/**
 * Serialise the registry rows into the exact shape the Copilot CLI expects.
 * `MCPServerView.env` is already masked (`***` for non-vault values) by
 * `mcp-service.toView` — we drop those so the export is import-safe.
 */
export function exportToCopilotMcpJson(servers: readonly MCPServerView[]): CopilotMcpJson {
  const out: CopilotMcpJson = { servers: {} };
  for (const s of servers) {
    if (!s.enabled) continue;
    const entry: CopilotMcpJson["servers"][string] = { type: s.transport };
    if (s.transport === "stdio") {
      if (s.command) entry.command = s.command;
      if (s.args && s.args.length > 0) entry.args = s.args.slice();
    } else {
      if (s.url) entry.url = s.url;
    }
    if (s.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env)) {
        // Skip masked plaintext to avoid round-trip corruption.
        if (v === "***") continue;
        if (typeof v === "string") env[k] = v;
      }
      if (Object.keys(env).length > 0) entry.env = env;
    }
    if (s.headers) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.headers)) {
        if (v === "***") continue;
        if (typeof v === "string") headers[k] = v;
      }
      if (Object.keys(headers).length > 0) entry.headers = headers;
    }
    out.servers[s.label] = entry;
  }
  return out;
}

/** Validate that a JSON payload looks like a Copilot mcp.json file. */
export function parseCopilotMcpJson(raw: unknown): CopilotMcpJson {
  if (raw && typeof raw === "object" && raw !== null) {
    // Accept the legacy `mcpServers` key from VS Code / Claude Desktop too.
    const maybe = raw as Record<string, unknown>;
    if (!maybe.servers && maybe.mcpServers && typeof maybe.mcpServers === "object") {
      return copilotMcpJsonSchema.parse({ servers: maybe.mcpServers });
    }
  }
  return copilotMcpJsonSchema.parse(raw);
}

/** Plan + audit a Copilot mcp.json import without persisting (dry-run). */
export async function previewCopilotMcpImport(raw: unknown): Promise<ImportPlan> {
  const parsed = parseCopilotMcpJson(raw);
  return buildImportPlan({ servers: parsed.servers });
}

/**
 * Persist a Copilot mcp.json import. Vault routing is handled by the existing
 * importer so secret-shaped env/header values land in the vault and the
 * MCPServer row stores `${vault:label}` refs only.
 */
export async function importFromCopilotMcpJson(
  raw: unknown,
  registry: MCPRegistryService,
  actor: { id: string; role?: import("@metis/shared").RoleKey },
  opts: { scope?: "global" | "project"; projectId?: string | null } = {},
): Promise<ImportResult> {
  const parsed = parseCopilotMcpJson(raw);
  return executeImport({ servers: parsed.servers }, registry, actor, opts);
}

export { isVaultRef };
