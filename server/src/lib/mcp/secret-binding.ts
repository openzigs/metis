/**
 * #344 — MCP servers bind the vault secrets their env references.
 *
 * `${vault:x}` inside an env value is expanded into the process (stdio), the
 * container (docker-stdio) or the pod (k8s-sse) the server's own config picks,
 * so the destination is everything that decides what runs and where it may
 * talk: transport, runtime, command, args, url, headers, the env itself (an
 * added `HTTPS_PROXY` or `NODE_OPTIONS` redirects an unchanged key) and the
 * k8s egress allow-list. Header references are collected as well, so a secret
 * cannot be staged there for a later change that starts expanding them.
 *
 * Model and error: `lib/vault/secret-binding.ts`.
 */
import { isDeepStrictEqual } from "node:util";
import type { AuthPayload } from "@metis/shared";
import { prisma } from "../prisma.js";
import { assertSecretBindingAllowed, refBodiesIn } from "../vault/secret-binding.js";
import { parseSecretBindings } from "../vault/bound-secret.js";
import type { ImportPlan } from "./mcp-importer.js";

type Caller = Pick<AuthPayload, "userId" | "role">;
type StringMap = Record<string, string> | null | undefined;

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

const emptyToNull = (v: unknown) =>
  v === undefined || v === "" || (Array.isArray(v) && v.length === 0) ? null : v;
const mapOrNull = (v: unknown) =>
  v && typeof v === "object" && Object.keys(v as object).length === 0 ? null : (v ?? null);

/** Any `${vault:x}` referenced from an env or headers map. */
export function mcpRefs(env: StringMap, headers: StringMap): string[] {
  return [...refBodiesIn(env), ...refBodiesIn(headers)];
}

export interface McpDestinationRow {
  transport: string;
  runtime: string | null;
  command: string | null;
  args: string | null;
  url: string | null;
  headers: string | null;
  envJson: string | null;
  egressAllowlist: string | null;
}

export interface McpDestinationPatch {
  runtime?: string | null;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  headers?: StringMap;
  env?: StringMap;
  egressAllowlist?: string | null;
}

/** True when a PATCH names a destination field with a value other than the stored one. */
export function mcpDestinationChanged(row: McpDestinationRow, patch: McpDestinationPatch): boolean {
  const differs = (next: unknown, stored: unknown) =>
    next !== undefined && !isDeepStrictEqual(emptyToNull(next), emptyToNull(stored));
  if (differs(patch.runtime, row.runtime ?? "native")) return true;
  if (differs(patch.command, row.command)) return true;
  if (patch.args !== undefined && differs(patch.args, parseJson(row.args))) return true;
  if (differs(patch.url, row.url)) return true;
  if (differs(patch.egressAllowlist, row.egressAllowlist)) return true;
  if (
    patch.headers !== undefined &&
    !isDeepStrictEqual(mapOrNull(patch.headers), mapOrNull(parseJson(row.headers)))
  ) {
    return true;
  }
  if (
    patch.env !== undefined &&
    !isDeepStrictEqual(mapOrNull(patch.env), mapOrNull(parseJson(row.envJson)))
  ) {
    return true;
  }
  return false;
}

/** A new server: every secret its env/headers reference must be the caller's. */
export async function assertMcpCreateSecretBinding(
  user: Caller,
  input: { env?: StringMap; headers?: StringMap; label: string },
): Promise<void> {
  await assertSecretBindingAllowed(
    user,
    { before: [], after: mcpRefs(input.env, input.headers), destinationChanged: true },
    { target: { type: "mcp_server", id: "new" }, metadata: { label: input.label } },
  );
}

/**
 * #537 — the references a server's env/headers hold that its stored bindings
 * do not cover: those the #504 backfill flagged (ambiguous, unresolved, or not
 * the creator's), which `expandVaultRefs` refuses, so the server cannot start.
 * A row the backfill has not reached yet (`secretBindings` NULL) is not judged.
 */
export function unboundMcpRefs(row: {
  envJson: string | null;
  headers: string | null;
  secretBindings?: string | null;
}): string[] {
  const bindings = parseSecretBindings(row.secretBindings);
  if (bindings === null) return [];
  const refs = mcpRefs(parseJson(row.envJson) as StringMap, parseJson(row.headers) as StringMap);
  return [...new Set(refs)].filter((ref) => !Object.hasOwn(bindings, ref));
}

/**
 * An update of server `id`. An unknown id is left to the route's own 404.
 * Returns the checked row's `updatedAt` (#479) for the conditional write, or
 * `null` when there is no row.
 */
export async function assertMcpUpdateSecretBinding(
  user: Caller,
  id: string,
  patch: McpDestinationPatch,
): Promise<Date | null> {
  const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
  if (!row) return null;
  const storedEnv = parseJson(row.envJson) as StringMap;
  const storedHeaders = parseJson(row.headers) as StringMap;
  const nextEnv = patch.env !== undefined ? patch.env : storedEnv;
  const nextHeaders = patch.headers !== undefined ? patch.headers : storedHeaders;
  // #537 — a reference the server holds but is not bound to (#504 flagged it)
  // is attached by this write, not kept: the update re-binds it, so it must
  // pass rule 1 like a new one. Otherwise any `mcp.manage` caller could re-save
  // a server and bind a secret the backfill refused to.
  const unbound = new Set(unboundMcpRefs(row));
  await assertSecretBindingAllowed(
    user,
    {
      before: mcpRefs(storedEnv, storedHeaders).filter((ref) => !unbound.has(ref)),
      after: mcpRefs(nextEnv, nextHeaders),
      destinationChanged: mcpDestinationChanged(row, patch),
    },
    { target: { type: "mcp_server", id }, metadata: { label: row.label } },
  );
  return row.updatedAt;
}

/**
 * #537 — re-binding server `id`'s flagged references ({@link unboundMcpRefs})
 * attaches them now, so each must be the caller's (#344 rule 1) unless they
 * hold `vault.reveal`. Nothing else about the server changes. Returns the
 * checked row's `updatedAt` for the conditional write, or `null` when there is
 * no row (the route's own 404).
 */
export async function assertMcpRebindSecretBinding(user: Caller, id: string): Promise<Date | null> {
  const row = await prisma.mCPServer.findFirst({ where: { id, deletedAt: null } });
  if (!row) return null;
  await assertSecretBindingAllowed(
    user,
    { before: [], after: unboundMcpRefs(row), destinationChanged: true },
    { target: { type: "mcp_server", id }, metadata: { label: row.label, rebind: true } },
  );
  return row.updatedAt;
}

/**
 * An mcp.json import: every secret an entry references must be the caller's.
 * Refs the import itself creates (auto-vaulted plaintext) are not in the input.
 */
export async function assertMcpImportSecretBinding(user: Caller, plan: ImportPlan): Promise<void> {
  for (const entry of plan.entries) {
    const env = Object.fromEntries(
      Object.entries(entry.env).filter(([k]) => !(k in entry.vaultedKeys)),
    );
    const headers = entry.headers
      ? Object.fromEntries(
          Object.entries(entry.headers).filter(([k]) => !(k in entry.vaultedHeaders)),
        )
      : null;
    await assertMcpCreateSecretBinding(user, { env, headers, label: entry.label });
  }
}
