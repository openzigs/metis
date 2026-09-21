/**
 * Epic #547 (Phase 4, #554) — Teams tenant allowlist (OWASP A01, defence in depth).
 *
 * The Bot Framework JWT (#548) proves an inbound activity genuinely came from the
 * Azure Bot Service for the configured app — it does NOT, by itself, restrict
 * WHICH Azure AD tenant may drive the bridge. A MultiTenant bot will accept a
 * validly-signed activity from ANY tenant the app is installed in. The tenant
 * allowlist is the operator's lever to pin the bridge to one (or a few) approved
 * tenant(s), so a validly-authenticated activity from an unexpected tenant is
 * rejected BEFORE it can resolve a sender, ingest a message, invoke the AI, or
 * promote a requirement.
 *
 * DEFAULT (documented, and surfaced in `docs/integrations/teams.md`):
 *   - `TEAMS_ALLOWED_TENANTS` UNSET / blank  → mode "allow-all". Any tenant whose
 *     activity passes JWT validation is accepted. This is the backward-compatible
 *     default (a SingleTenant bot is already pinned to one tenant by Azure, and a
 *     MultiTenant bot that an operator has deliberately installed broadly should
 *     keep working). Operators running a MultiTenant bot that should be restricted
 *     MUST set this — the docs call this out as an operator responsibility.
 *   - `TEAMS_ALLOWED_TENANTS=t1,t2`          → mode "allowlist". ONLY the listed
 *     tenant ids (case-insensitive) are accepted; everything else — including a
 *     tenant-LESS sender whose tenant cannot be proven — is rejected.
 *
 * The tenant id itself is sourced from the activity exactly as the prior phases
 * do (`channelData.tenant.id`, then `conversation.tenantId`, then the link's
 * recorded tenant) — this module only owns the ALLOW/DENY decision, not the
 * extraction precedence.
 */

/** Where an inbound activity's tenant id came from (allowlist is decision-only). */
export type TeamsTenantPolicyMode = "allow-all" | "allowlist";

export interface TeamsTenantPolicy {
  mode: TeamsTenantPolicyMode;
  /** Normalized (lower-cased, trimmed, deduped) allowed tenant ids. Empty when allow-all. */
  tenants: string[];
}

/** Thrown when an inbound activity's tenant is not on the configured allowlist. */
export class TeamsTenantNotAllowedError extends Error {
  constructor() {
    // Deliberately generic — never echo the allowlist or the rejected tenant id
    // into the error (which could surface in a log line correlated to a channel).
    super("Teams tenant is not permitted to use this bridge");
    this.name = "TeamsTenantNotAllowedError";
  }
}

/** Normalize a raw tenant id for comparison (trim + lower-case). */
function normalize(tenantId: string | null | undefined): string {
  return (tenantId ?? "").trim().toLowerCase();
}

/**
 * Parse the allowlist from config. Empty/blank → allow-all (documented default).
 * Entries are trimmed, lower-cased, blanks dropped, and deduped (order preserved).
 */
export function loadTeamsTenantAllowlist(env: NodeJS.ProcessEnv = process.env): TeamsTenantPolicy {
  const raw = (env.TEAMS_ALLOWED_TENANTS ?? "").trim();
  if (raw.length === 0) {
    return { mode: "allow-all", tenants: [] };
  }
  const seen = new Set<string>();
  const tenants: string[] = [];
  for (const part of raw.split(",")) {
    const t = normalize(part);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    tenants.push(t);
  }
  // A list that was non-blank but parsed to nothing (e.g. ",,,") is still an
  // explicit signal the operator intended to restrict — fail safe to deny-all
  // rather than silently degrading to allow-all.
  return { mode: "allowlist", tenants };
}

/**
 * Decide whether an activity's tenant id is permitted under `policy`.
 *
 *   - allow-all → always true (even for a tenant-less sender).
 *   - allowlist → true only if the (normalized) tenant id is on the list. A
 *     tenant-LESS sender (null/blank) is rejected: under an allowlist we cannot
 *     prove the tenant, so we must not accept it.
 */
export function isTeamsTenantAllowed(
  policy: TeamsTenantPolicy,
  tenantId: string | null | undefined,
): boolean {
  if (policy.mode === "allow-all") return true;
  const t = normalize(tenantId);
  if (!t) return false;
  return policy.tenants.includes(t);
}

/** Assert the tenant is allowed; throws {@link TeamsTenantNotAllowedError} otherwise. */
export function assertTeamsTenantAllowed(
  policy: TeamsTenantPolicy,
  tenantId: string | null | undefined,
): void {
  if (!isTeamsTenantAllowed(policy, tenantId)) {
    throw new TeamsTenantNotAllowedError();
  }
}
