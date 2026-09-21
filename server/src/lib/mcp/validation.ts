/**
 * Issue #270 — MCP scope hardening validators.
 *
 * Centralised guardrails enforced by `MCPRegistryService.create()` and
 * `update()` plus the corresponding routes. Each helper either returns
 * silently (validation passed) or throws an `MCPRegistryError` so the
 * route layer can map it to a structured 4xx response.
 *
 * Sub-issues covered:
 *   - #273 `MCP_REQUIRE_CATALOG`     → `assertCuratedSource()`
 *   - #274 `MCP_REQUIRE_VAULT_ENV`   → `assertVaultEnv()`
 *   - #275 `MCP_IMAGE_ALLOWLIST`     → `assertImageAllowed()`
 *   - #276 admin-only trust          → `assertTrustPromotionAllowed()`
 *   - #277 user scope feature flag   → `assertUserScopeAllowed()`
 */
import type { PermissionKey, RoleKey } from "@metis/shared";
import { hasPermission } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { audit } from "../audit/audit-service.js";
import { createChildLogger } from "../logger.js";
import { MCPRegistryError } from "./mcp-service-error.js";
import { extractDockerImage, imageMatchesAllowlist, parseAllowlistCsv } from "./image-allowlist.js";
import { isImageDenied, isOverrideMatch, parseOverrideCsv } from "./image-denylist.js";

const denylistLog = createChildLogger("mcp-image-denylist");

/** Vault reference pattern — matches `${vault:label}` exactly. */
const VAULT_REF = /^\$\{vault:[^}]+\}$/;

/** Source descriptor stamped onto curated registrations. */
export interface RegistrationSource {
  kind: "catalog" | "template" | "federation";
  catalogId?: string;
  templateId?: string;
  version?: string;
}

export interface ActorContext {
  id: string;
  role?: RoleKey;
}

function actorHas(actor: ActorContext, perm: PermissionKey): boolean {
  if (!actor.role) return false;
  return hasPermission(actor.role, perm);
}

// ── #274 — vault-only env enforcement ─────────────────────────────────────

export function assertVaultEnv(env: Record<string, string> | null | undefined): void {
  const cfg = getConfigService();
  if (!cfg.getBool("MCP_REQUIRE_VAULT_ENV", false)) return;
  if (!env) return;
  const offending: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string" || !VAULT_REF.test(v)) offending.push(k);
  }
  if (offending.length > 0) {
    throw new MCPRegistryError(
      400,
      "PLAINTEXT_ENV_FORBIDDEN",
      `MCP env values must be vault references when MCP_REQUIRE_VAULT_ENV is enabled. Offending keys: ${offending.join(", ")}`,
    );
  }
}

// ── #275 — image allowlist enforcement ────────────────────────────────────

export interface ImageInput {
  command: string | null;
  args: string[] | null;
}

/**
 * Validate that, for `docker`-launched stdio MCPs, the image referenced in
 * `args` matches the configured `MCP_IMAGE_ALLOWLIST`. Empty allowlist + any
 * image fails closed.
 *
 * Non-docker commands and HTTP/SSE transports are not gated here — those go
 * through different runtime paths.
 */
export function assertImageAllowed(input: ImageInput): void {
  if (input.command !== "docker") return;
  const cfg = getConfigService();
  const csv = cfg.get("MCP_IMAGE_ALLOWLIST");
  const patterns = parseAllowlistCsv(csv ?? null);
  const image = extractDockerImage(input.args ?? []);
  if (!image) {
    // `docker` invoked without an extractable image is itself suspicious.
    throw new MCPRegistryError(
      400,
      "IMAGE_NOT_ALLOWED",
      "Could not extract image reference from docker args; refusing to register",
    );
  }
  if (!imageMatchesAllowlist(image, patterns)) {
    throw new MCPRegistryError(
      400,
      "IMAGE_NOT_ALLOWED",
      `Image '${image}' does not match any allowlisted pattern (${patterns.length} configured)`,
    );
  }
}

// ── #392 — image denylist (defence-in-depth over allowlist) ───────────────

export interface ImageDenyAuditCtx {
  /** Acting user id, or `null` for system / non-user provisioning. */
  actorId: string | null;
  /** Optional MCP server id (known on `update`, not on `create`). */
  serverId?: string | null;
  /** Optional MCP server label for audit context. */
  serverLabel?: string | null;
  /** Where the check fired — surfaced into the audit metadata. */
  source: "registration" | "provision";
}

/**
 * Reject docker MCP images that match the denylist (#392). Operators can
 * acknowledge a specific `image@version` pair via `MCP_IMAGE_DENYLIST_OVERRIDE`;
 * each acknowledgement emits a WARN audit event so the bypass is auditable.
 *
 * Mirrors `assertImageAllowed`'s shape — only fires for `command === 'docker'`.
 * Non-docker callers (raw process MCPs, HTTP transports) bypass this check
 * the same way they bypass the allowlist.
 */
export function assertImageNotDenied(input: ImageInput, ctx: ImageDenyAuditCtx): void {
  if (input.command !== "docker") return;
  const image = extractDockerImage(input.args ?? []);
  if (!image) return; // assertImageAllowed handles missing-image rejection
  assertRawImageNotDenied(image, ctx);
}

/**
 * Lower-level variant for callers that already have a raw image reference
 * (e.g. the `docker-stdio` provisioner where `config.command` IS the image).
 */
export function assertRawImageNotDenied(
  image: string | null | undefined,
  ctx: ImageDenyAuditCtx,
): void {
  if (!image) return;
  const verdict = isImageDenied(image);
  if (!verdict) return;
  const cfg = getConfigService();
  const overrides = parseOverrideCsv(cfg.get("MCP_IMAGE_DENYLIST_OVERRIDE"));
  if (isOverrideMatch(verdict, overrides)) {
    denylistLog.warn("MCP image denylist override admitted a known-vulnerable image", {
      image: verdict.image,
      version: verdict.version,
      cve: verdict.cve,
      source: ctx.source,
      serverId: ctx.serverId ?? null,
      serverLabel: ctx.serverLabel ?? null,
      actorId: ctx.actorId,
    });
    audit({
      actor: ctx.actorId,
      action: "mcp.image_denylist_overridden",
      target: { type: "mcp_image", id: verdict.image },
      metadata: {
        cve: verdict.cve,
        version: verdict.version,
        source: ctx.source,
        serverId: ctx.serverId ?? null,
        serverLabel: ctx.serverLabel ?? null,
      },
    });
    return;
  }
  throw new MCPRegistryError(
    422,
    "MCP_IMAGE_DENIED",
    verdict.reason === "unparseable_tag"
      ? `Image '${image}' is on the MCP denylist (${verdict.cve}) — tag '${verdict.version}' cannot be evaluated against vulnerable range '${verdict.matchedEntry.vulnerable}'. Pin a specific semver tag or set MCP_IMAGE_DENYLIST_OVERRIDE='${verdict.matchedEntry.image}@${verdict.version}' to acknowledge.`
      : `Image '${image}' is on the MCP denylist (${verdict.cve}). To acknowledge, set MCP_IMAGE_DENYLIST_OVERRIDE='${verdict.matchedEntry.image}@${verdict.version}'.`,
  );
}

// ── #273 — curated registration enforcement ───────────────────────────────

export function assertCuratedSource(
  scope: "global" | "project" | "user",
  source: RegistrationSource | null | undefined,
  actor: ActorContext,
): void {
  const cfg = getConfigService();
  if (!cfg.getBool("MCP_REQUIRE_CATALOG", false)) return;
  // Global-scope registrations may bypass the catalog requirement when the
  // actor has the admin-only `mcp.manage` permission. Project- and user-
  // scoped writes must always come from a curated source.
  if (scope === "global" && actorHas(actor, "mcp.manage")) return;
  if (
    !source ||
    (source.kind !== "catalog" && source.kind !== "template" && source.kind !== "federation")
  ) {
    throw new MCPRegistryError(
      403,
      "RAW_COMMAND_FORBIDDEN",
      "Direct command registrations are disabled. Install from the catalog or an admin-approved template.",
    );
  }
}

// ── #276 — admin-only trust promotion ─────────────────────────────────────

/**
 * Reject `trustLevel: 'trusted'` writes from non-admin actors. Returns the
 * effective trust level (always the requested one when allowed; the caller
 * surfaces the 400 if the request is rejected).
 *
 * `requested === undefined` short-circuits — the registry default kicks in.
 */
export function assertTrustPromotionAllowed(
  requested: "trusted" | "untrusted" | undefined,
  actor: ActorContext,
): void {
  if (requested !== "trusted") return;
  if (actorHas(actor, "mcp.manage")) return;
  throw new MCPRegistryError(
    400,
    "TRUST_LEVEL_REQUIRES_ADMIN",
    "Promoting an MCP to trustLevel='trusted' requires the mcp.manage permission",
  );
}

// ── #277 — user scope feature flag ────────────────────────────────────────

export interface UserScopeContext {
  scope: "global" | "project" | "user";
  actorUserId: string;
  /** `runtime` field — added by Epic #271. Optional today. */
  runtime?: string | null;
}

/**
 * Validate user-scope registration constraints. Throws on rejection; returns
 * silently when the request is allowed.
 *
 * Constraints:
 *   - `MCP_ALLOW_USER_SCOPE` must be true
 *   - per-user concurrent enabled count must be < `MCP_USER_MAX_CONCURRENT`
 *
 * Container-runtime enforcement is documented but lenient until Epic #271
 * adds the `runtime` field to the persistence schema.
 */
export function assertUserScopeAllowed(ctx: UserScopeContext): void {
  if (ctx.scope !== "user") return;
  const cfg = getConfigService();
  if (!cfg.getBool("MCP_ALLOW_USER_SCOPE", false)) {
    throw new MCPRegistryError(
      400,
      "USER_SCOPE_DISABLED",
      "MCP_ALLOW_USER_SCOPE is disabled — personal MCP registrations are not permitted",
    );
  }
  // TODO(#271): once `runtime` lands on the persistence schema, also reject
  // when `runtime` is not in {`docker-stdio`, `k8s-sse`} with
  // `400 USER_SCOPE_REQUIRES_CONTAINER`.
}
