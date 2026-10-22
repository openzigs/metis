/**
 * Token lifetimes, read from the environment once at load.
 *
 * Split out of `jwt.ts` (#1414) so `socket/session-disconnect.ts` can size its
 * ended-session records without importing `jwt.ts`, which imports the socket
 * layer itself. `jwt.ts` re-exports both helpers, so existing callers are
 * unchanged.
 */

/** `JWT_ACCESS_EXPIRY`, a jsonwebtoken-style expiry; default one hour. */
export const ACCESS_EXPIRY = process.env.JWT_ACCESS_EXPIRY ?? "1h";

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

/** #1414 — the access-token lifetime in seconds (`JWT_ACCESS_EXPIRY`, default 1h). */
export function accessTokenTtlSeconds(): number {
  return parseExpiryToSeconds(ACCESS_EXPIRY);
}
