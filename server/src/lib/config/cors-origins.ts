/**
 * #913 / #1349 — the browser origins the API trusts, parsed once and shared by
 * `cors()`, the CSRF guard and the socket.io handshake's Origin check.
 *
 * Its own module so the socket server can read it without importing `app.ts`
 * (and with it every router).
 */

/** The default `CORS_ORIGIN`: the Next UI on its dev port. */
export const DEFAULT_CORS_ORIGIN = "http://localhost:3000";

/**
 * `CORS_ORIGIN` as the list of origins it names: comma-separated, trimmed,
 * empty entries dropped. Shared by `cors()` and `csrfProtection`.
 */
export function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
}

/** Normalise an origin string to `scheme://host[:port]`, or null when it is not one. */
export function normaliseOrigin(raw: string | undefined): string | null {
  if (!raw || raw === "null") return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * #1349 — the origins a cookie-authenticated socket.io handshake may come
 * from: every `CORS_ORIGIN` entry (the browser UI connects to the socket
 * server directly, from its own origin) and every `METIS_TRUSTED_ORIGINS`
 * entry (the UI's list of extra origins, #913), normalised. Entries that are
 * not an http(s) origin are dropped, so they can match nothing.
 */
export function socketTrustedOrigins(
  corsOrigin: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const raw = [
    ...parseCorsOrigins(corsOrigin ?? env.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN),
    ...parseCorsOrigins(env.METIS_TRUSTED_ORIGINS ?? ""),
  ];
  return new Set(raw.map((o) => normaliseOrigin(o)).filter((o): o is string => o !== null));
}
