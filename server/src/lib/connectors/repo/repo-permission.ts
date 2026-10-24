/**
 * #1488 — what a repository connector's credential may do on its repository,
 * and which Test failures say something about the connector at all.
 *
 * Shared-secret webhook routing (`findProjectForRepo`) used to trust
 * `status: "connected"`, which proves only that `repos.get` succeeded. A public
 * repository answers that with no credential, so a tenant in another workspace
 * could connect it first and take every delivery signed with the deployment
 * secret. Only a repository admin can register a webhook, so the credential
 * that may take those deliveries is one GitHub says can write to it.
 */

/** Recorded on `repo_connections.repoPermission`. NULL = not recorded. */
export const REPO_PERMISSIONS = ["admin", "push", "read", "unknown", "none"] as const;
export type RepoPermission = (typeof REPO_PERMISSIONS)[number];

/** `repos.get` → `permissions`, present only on an authenticated request. */
export interface GithubRepoPermissions {
  admin?: boolean;
  maintain?: boolean;
  push?: boolean;
  triage?: boolean;
  pull?: boolean;
}

/**
 * The permission to record after a successful `repos.get`. An unauthenticated
 * request is `none` whatever the response says. An authenticated one with no
 * `permissions` object is `unknown`: the read succeeded, GitHub said nothing
 * about the token's role, and nothing proves more. Both are ineligible; they
 * are kept apart so the card does not call an unreported token read-only.
 */
export function repoPermissionOf(
  authenticated: boolean,
  permissions: GithubRepoPermissions | null | undefined,
): RepoPermission {
  if (!authenticated) return "none";
  if (!permissions) return "unknown";
  if (permissions.admin === true) return "admin";
  // `maintain` is a superset of `push` on GitHub's role ladder.
  if (permissions.push === true || permissions.maintain === true) return "push";
  return "read";
}

/** The stored value as the read DTO's enum; anything unrecognised reads as not recorded. */
export function repoPermissionDto(value: string | null | undefined): RepoPermission | null {
  return (REPO_PERMISSIONS as readonly string[]).includes(value ?? "")
    ? (value as RepoPermission)
    : null;
}

/** May this connector take deliveries signed with the shared deployment secret? */
export function isSharedWebhookEligible(permission: string | null | undefined): boolean {
  return permission === "admin" || permission === "push";
}

/** A narrowed view of an Octokit `RequestError`. */
interface GithubErrorLike {
  status?: unknown;
  message?: unknown;
  response?: { headers?: Record<string, unknown> | null } | null;
}

function header(err: GithubErrorLike, name: string): string | undefined {
  const v = err.response?.headers?.[name];
  return v === undefined || v === null ? undefined : String(v);
}

/**
 * Is this GitHub failure about the server rather than the connector — a rate
 * limit (primary or secondary), a 5xx, or an aborted request? Such a failure
 * says nothing about the credential, so a Test that hits one must not mark the
 * connector `error`: on #1488 an attacker who spent the server IP's 60/hour
 * unauthenticated quota made the incumbent's refresh write `error`, handing its
 * deliveries to the attacker's connector.
 *
 * A 403 that is not a rate limit is a refusal of this credential (an explicit
 * permission loss: SSO enforcement, a revoked grant) and is NOT transient.
 * 401 and 404 are never transient.
 */
export function isTransientGithubFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as GithubErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status === undefined) {
    // No HTTP status. `@octokit/request` already turns a failed fetch (reset,
    // DNS, TLS) into a status-500 `RequestError`, handled below; what lands
    // here is an aborted request (transient) or a non-HTTP error raised after
    // the request (a database failure, an unexpected response shape), which
    // is not a GitHub failure and must not be reported as a temporary one.
    return (e as { name?: unknown }).name === "AbortError";
  }
  if (status >= 500 || status === 429) return true;
  if (status !== 403) return false;
  if (header(e, "x-ratelimit-remaining") === "0") return true;
  if (header(e, "retry-after") !== undefined) return true;
  const message = typeof e.message === "string" ? e.message : "";
  return /rate limit/i.test(message);
}
