/**
 * Issue #105 — MCP server integrity (sha256 pin + tool-schema diff).
 *
 * Computes a stable SHA-256 over a string/buffer (used to verify a downloaded
 * MCP package matches the pinned `sha256` recorded on the server row), and
 * produces a diff between the LAST APPROVED tool-schema snapshot and the
 * CURRENTLY ADVERTISED set. Any non-empty diff blocks tool invocation until an
 * operator explicitly re-approves the new snapshot — this is the protection
 * against "rug-pull" servers that change their tool surface mid-session.
 */
import crypto from "node:crypto";
import type { MCPSchemaDiff, MCPToolDescriptor } from "@metis/shared";

export function computeSha256(payload: string | Uint8Array | Buffer): string {
  const h = crypto.createHash("sha256");
  if (typeof payload === "string") h.update(payload, "utf8");
  else h.update(payload);
  return h.digest("hex");
}

/**
 * Snapshot a server's currently advertised tools to a deterministic shape.
 * Object keys are sorted recursively so equivalent schemas hash identically.
 */
export function snapshotToolSchemas(tools: MCPToolDescriptor[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const t of tools) {
    out[t.name] = {
      description: t.description ?? "",
      risk: t.risk,
      inputSchema: canonicalize(t.inputSchema ?? null),
    };
  }
  // Re-sort the top-level keys so the resulting object is order-stable.
  return Object.fromEntries(
    Object.keys(out)
      .sort()
      .map((k) => [k, out[k]]),
  );
}

/**
 * Diff two snapshots. `null`/`undefined` snapshots are treated as "no
 * baseline" — every tool counts as `added`. The `changed` list is computed
 * against the canonical input-schema string so semantically-equivalent objects
 * with different key orderings do NOT show as changed.
 */
export function diffSchemas(
  oldSnapshot: Record<string, unknown> | null | undefined,
  newSnapshot: Record<string, unknown> | null | undefined,
): MCPSchemaDiff {
  const o = oldSnapshot ?? {};
  const n = newSnapshot ?? {};
  const oKeys = new Set(Object.keys(o));
  const nKeys = new Set(Object.keys(n));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const k of nKeys) {
    if (!oKeys.has(k)) added.push(k);
    else if (canonicalize(o[k]) !== canonicalize(n[k])) changed.push(k);
  }
  for (const k of oKeys) {
    if (!nKeys.has(k)) removed.push(k);
  }
  added.sort();
  removed.sort();
  changed.sort();
  return { added, removed, changed };
}

export function isDiffEmpty(diff: MCPSchemaDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
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
