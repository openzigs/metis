/**
 * JWT issuance and verification.
 *
 * - HS256 with `JWT_SECRET` from env. Fails fast EVERYWHERE except genuine
 *   local development — see `isLocalDevelopment` / `resolveJwtSecret` (#1057).
 * - 1h access tokens, 7d refresh tokens.
 * - Refresh tokens carry a `tokenId` so single-use rotation can revoke them.
 *
 * Token revocation is PERSISTENT (Epic #404, #413): revoked tokenIds and the
 * per-user session cutoff live in Prisma DB tables via `revocation-store.ts`,
 * so a server restart no longer wipes revocation state and force-logs-out every
 * user. The store interface is abstracted so a distributed deployment can swap
 * the Prisma backing for another implementation without touching this file.
 */
import jwt, { type SignOptions } from "jsonwebtoken";
import { ulid } from "ulid";
import type { AuthPayload, PermissionKey, RoleKey } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { revocationStore, type RevocationStore } from "./revocation-store.js";

const log = createChildLogger("jwt");

const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY ?? "1h";
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY ?? "7d";

const MIN_SECRET_BYTES = 32;

/** Default refresh TTL (7 days) in seconds, used when an expiry can't be parsed. */
const DEFAULT_REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Parse a jsonwebtoken-style expiry ("7d", "1h", "3600", "30m") into seconds.
 * Falls back to the 7-day refresh default for anything unrecognised so a
 * misconfigured env can never produce a non-expiring revoked row.
 */
export function parseExpiryToSeconds(expiry: string): number {
  const match = /^(\d+)\s*([smhdw])?$/.exec(expiry.trim());
  if (!match) {
    return DEFAULT_REFRESH_TTL_SECONDS;
  }
  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    w: 7 * 24 * 60 * 60,
  };
  return value * (multipliers[unit] ?? 1);
}

/**
 * The hardcoded local-development signing key. It is in the source tree, so it
 * is PUBLIC: anyone can mint a token for any user id and any role with it.
 * Exported so callers/tests can name it explicitly rather than copying it.
 */
export const DEV_FALLBACK_SECRET = "dev-only-jwt-secret-do-not-use-in-production";

/**
 * Values that look like a secret but are not one — the placeholder shipped in
 * `.env.example` and the dev fallback itself. Setting `JWT_SECRET` to either is
 * treated exactly like leaving it unset, because both are published strings.
 */
const NON_SECRET_VALUES: readonly string[] = [
  "replace-me-with-a-long-random-string",
  DEV_FALLBACK_SECRET,
];

/**
 * Issue #1057 (F8, CWE-798) — is this process genuinely a local development
 * environment?
 *
 * The old test was `NODE_ENV !== "production"`, i.e. a NEGATIVE signal, so
 * every environment that wasn't spelled exactly `production` — staging, a
 * preview/review app, CI reachable off-localhost, or a container image that
 * simply never set `NODE_ENV` — silently inherited the publicly-known dev
 * signing key. A missing env var is the single most likely misconfiguration,
 * and it landed on the INSECURE side of the branch.
 *
 * The rule is now a POSITIVE opt-in, so the default (unset) fails closed:
 *
 * - `NODE_ENV` must be exactly `development` or `test` (case/whitespace
 *   normalised). `test` is included because the vitest suite and the Playwright
 *   harness run under it; both are local/ephemeral by construction. Nothing
 *   else qualifies — `staging`, `preview`, `prod`, `dev`, `""` and unset all
 *   fail closed.
 * - AND the process must not look like an orchestrated deployment. A pod gets
 *   `KUBERNETES_SERVICE_HOST` injected by the kubelet, so a review app deployed
 *   to a cluster with `NODE_ENV=development` is still refused. This is
 *   defense-in-depth only: it can make the check STRICTER, never looser, so an
 *   environment where the variable happens to be absent is no worse off than
 *   under the `NODE_ENV` check alone.
 *
 * Note there is deliberately no bind-address test: `index.ts` calls
 * `listen(PORT)` with no host, i.e. it always binds `0.0.0.0`. A loopback check
 * would therefore reject ordinary local development too, and requiring
 * developers to set `HOST=127.0.0.1` would break `pnpm dev` for no real gain.
 */
export function isLocalDevelopment(env: NodeJS.ProcessEnv = process.env): boolean {
  const nodeEnv = (env.NODE_ENV ?? "").trim().toLowerCase();
  if (nodeEnv !== "development" && nodeEnv !== "test") return false;
  // A Kubernetes pod is never a developer's laptop.
  if (env.KUBERNETES_SERVICE_HOST) return false;
  return true;
}

export interface JwtSecretResolution {
  /** The HS256 signing key to use. */
  secret: string;
  /** True when the publicly-known {@link DEV_FALLBACK_SECRET} is in play. */
  usingInsecureFallback: boolean;
  /** Operator-facing warnings; empty when the configuration is sound. */
  warnings: string[];
}

/**
 * Resolve the signing secret from an env snapshot, or throw with an actionable
 * message. Pure (no logging, no `process.env` access unless defaulted) so the
 * policy can be tested exhaustively without mutating global state.
 *
 * @throws when the environment is not local development and `JWT_SECRET` is
 * missing, a known placeholder, or shorter than {@link MIN_SECRET_BYTES}.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): JwtSecretResolution {
  const raw = env.JWT_SECRET ?? "";
  // Normalise for the emptiness/placeholder CHECK only — the value handed to
  // jsonwebtoken stays byte-identical, so a `.env` with a stray trailing space
  // keeps signing the same tokens it did before this change.
  const normalized = raw.trim();
  const localDev = isLocalDevelopment(env);
  const nodeEnvLabel = (env.NODE_ENV ?? "").trim() || "unset";

  if (!normalized || NON_SECRET_VALUES.includes(normalized)) {
    if (!localDev) {
      throw new Error(
        `JWT_SECRET must be set to a strong value (NODE_ENV=${JSON.stringify(nodeEnvLabel)}). ` +
          "Refusing to start: the development fallback key is published in this repository, " +
          "so anyone could forge an access token for any user, including admin. " +
          "The fallback is available ONLY in local development (NODE_ENV=development or test, " +
          "outside a container platform). " +
          `Generate one with \`openssl rand -hex 32\` (minimum ${MIN_SECRET_BYTES} bytes).`,
      );
    }
    return {
      secret: DEV_FALLBACK_SECRET,
      usingInsecureFallback: true,
      warnings: [
        "INSECURE JWT SIGNING KEY: JWT_SECRET is unset (or still a placeholder), so tokens " +
          "are being signed with the publicly known development key baked into this source " +
          "tree. Anyone who can read the repository can forge an admin token. This is " +
          "permitted in local development only — set JWT_SECRET (`openssl rand -hex 32`) " +
          "before exposing this process to any network.",
      ],
    };
  }

  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes < MIN_SECRET_BYTES) {
    // Enforced outside production too (issue #1057), so a weak staging secret
    // is caught at startup instead of quietly protecting a real deployment.
    if (!localDev) {
      throw new Error(
        `JWT_SECRET must be at least ${MIN_SECRET_BYTES} bytes ` +
          `(NODE_ENV=${JSON.stringify(nodeEnvLabel)}); got ${bytes}. ` +
          "Generate one with `openssl rand -hex 32`.",
      );
    }
    return {
      secret: raw,
      usingInsecureFallback: false,
      warnings: [
        `WEAK JWT SIGNING KEY: JWT_SECRET is shorter than 32 bytes (${bytes}). This is ` +
          "tolerated in local development only; any other environment refuses to start.",
      ],
    };
  }

  return { secret: raw, usingInsecureFallback: false, warnings: [] };
}

/**
 * Warnings already logged. `getSecret()` runs on every issue/verify — i.e. on
 * every authenticated request — so without dedupe the fallback warning would
 * drown the dev log and stop being read.
 */
const warnedMessages = new Set<string>();

function emitSecretWarnings(warnings: readonly string[], once: boolean): void {
  for (const message of warnings) {
    if (once && warnedMessages.has(message)) continue;
    warnedMessages.add(message);
    log.warn(message);
  }
}

/** Test helper — clears the warn-once dedupe. */
export function __resetJwtSecretWarnings(): void {
  warnedMessages.clear();
}

/**
 * Boot-time gate: throws (so `index.ts` exits non-zero) when the signing secret
 * is unusable, and emits the insecure-fallback warning exactly where an
 * operator will see it — in the startup log — rather than on first login.
 */
export function assertJwtSecretConfigured(): void {
  const resolution = resolveJwtSecret(process.env);
  // Startup always logs, even if a warning was already emitted lazily.
  emitSecretWarnings(resolution.warnings, false);
}

function getSecret(): string {
  const resolution = resolveJwtSecret(process.env);
  emitSecretWarnings(resolution.warnings, true);
  return resolution.secret;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface IssueTokensInput {
  userId: string;
  username: string;
  role: RoleKey;
  permissions: readonly PermissionKey[];
  /** Epic #759 — workspace IDs the user belongs to. */
  workspaces?: string[];
}

export interface RefreshPayload {
  userId: string;
  username: string;
  role: RoleKey;
  permissions: readonly PermissionKey[];
  workspaces?: string[];
  tokenId: string;
  type: "refresh";
  iat?: number;
  exp?: number;
}

/**
 * The persistence adapter backing revocation. Defaults to the shared Prisma
 * store; `setRevocationStore` lets tests inject an in-memory/mock double so the
 * suite never needs a live database.
 */
let store: RevocationStore = revocationStore;

/** Override the revocation store (tests / distributed-store swap). */
export function setRevocationStore(next: RevocationStore): void {
  store = next;
}

/** Refresh-token lifetime in seconds — used to compute a revoked row's TTL. */
function refreshTtlSeconds(): number {
  return parseExpiryToSeconds(REFRESH_EXPIRY);
}

/** Issue a fresh access + refresh token pair. */
export function issueTokens(input: IssueTokensInput): TokenPair {
  const tokenId = ulid();
  const secret = getSecret();
  const accessOpts: SignOptions = { expiresIn: ACCESS_EXPIRY as SignOptions["expiresIn"] };
  const refreshOpts: SignOptions = { expiresIn: REFRESH_EXPIRY as SignOptions["expiresIn"] };

  const accessToken = jwt.sign(
    {
      userId: input.userId,
      username: input.username,
      role: input.role,
      permissions: input.permissions,
      ...(input.workspaces?.length ? { workspaces: input.workspaces } : {}),
    } satisfies Omit<AuthPayload, "iat" | "exp">,
    secret,
    accessOpts,
  );
  const refreshToken = jwt.sign(
    {
      userId: input.userId,
      username: input.username,
      role: input.role,
      permissions: input.permissions,
      ...(input.workspaces?.length ? { workspaces: input.workspaces } : {}),
      tokenId,
      type: "refresh",
    } satisfies Omit<RefreshPayload, "iat" | "exp">,
    secret,
    refreshOpts,
  );
  log.debug("Tokens issued", { userId: input.userId, username: input.username });
  return { accessToken, refreshToken };
}

/** Verify an access token. Throws on invalid/expired/malformed input. */
export function verifyAccessToken(token: string): AuthPayload {
  const decoded = jwt.verify(token, getSecret()) as AuthPayload & { type?: string };
  if (decoded.type === "refresh") {
    throw new Error("Refresh token cannot be used for authentication");
  }
  return decoded;
}

/**
 * Verify a refresh token and ensure it has not been revoked.
 *
 * Async because the revocation check now hits the persistent store (an indexed
 * `tokenId` lookup + an optional per-user cutoff read). The throw messages are
 * unchanged so callers and tests asserting `/revoked/` keep working.
 */
export async function verifyRefreshToken(token: string): Promise<RefreshPayload> {
  const decoded = jwt.verify(token, getSecret()) as RefreshPayload;
  if (decoded.type !== "refresh") {
    throw new Error("Invalid token type");
  }
  if (await store.isRevoked(decoded.tokenId, decoded.userId, decoded.iat)) {
    throw new Error("Token has been revoked");
  }
  return decoded;
}

/**
 * Persistently revoke a single refresh token (single-use rotation, logout).
 *
 * `userId`/`expiresAt` default to a generic owner and the refresh TTL when the
 * caller only has the tokenId; pass the decoded payload's values for accurate
 * per-user grouping and TTL-based pruning.
 */
export async function revokeRefreshToken(
  tokenId: string,
  userId = "unknown",
  expiresAt: Date = new Date(Date.now() + refreshTtlSeconds() * 1000),
): Promise<void> {
  await store.revokeToken(tokenId, userId, expiresAt);
}

/**
 * Revoke all active sessions (refresh tokens) for a user by recording a session
 * cutoff = now. Every refresh token issued at/before this instant is rejected;
 * a token issued AFTER (e.g. re-provisioned + re-login) still validates.
 * Used by SCIM deprovisioning (DELETE / PATCH active=false).
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  await store.revokeAllForUser(userId);
}

/** Check if a user currently has an active session-revocation cutoff. */
export async function isUserDisabled(userId: string): Promise<boolean> {
  return store.isUserRevoked(userId);
}

/** Re-enable a user (if they are re-provisioned via SCIM). */
export async function enableUser(userId: string): Promise<void> {
  await store.clearUserRevocation(userId);
}

/**
 * Prune revoked-token rows whose underlying refresh token has already expired,
 * so the table cannot grow unbounded. Safe to call on a lightweight interval.
 */
export async function pruneExpiredRevocations(): Promise<number> {
  return store.pruneExpired();
}

/** Convenience: rotate a refresh token, returning a new pair. */
export async function refreshAccessToken(refreshToken: string): Promise<TokenPair> {
  const decoded = await verifyRefreshToken(refreshToken);
  const expiresAt =
    decoded.exp !== undefined
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + refreshTtlSeconds() * 1000);
  await revokeRefreshToken(decoded.tokenId, decoded.userId, expiresAt);
  return issueTokens({
    userId: decoded.userId,
    username: decoded.username,
    role: decoded.role,
    permissions: decoded.permissions,
    ...(decoded.workspaces?.length ? { workspaces: decoded.workspaces } : {}),
  });
}
