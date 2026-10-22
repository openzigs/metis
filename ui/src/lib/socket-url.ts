/**
 * #1377 — where the browser opens its Socket.IO connection.
 *
 * The URL used to be `process.env.NEXT_PUBLIC_SOCKET_URL ?? "http://localhost:4000"`.
 * Next.js inlines `NEXT_PUBLIC_*` at `next build`, and the release image is built
 * without it, so every deployment dialled `http://localhost:4000` whatever host
 * served the page: behind an ingress live updates never connected, and an analyst
 * with something listening on :4000 received the cookie-bearing handshake.
 *
 * Resolution, first match wins:
 *
 *   1. `METIS_BROWSER_SOCKET_URL`, read by the UI server AT REQUEST TIME and served
 *      to the page by `/runtime-config` (see `app/runtime-config/route.ts`).
 *      This is the runtime override: one image, any topology.
 *   2. `NEXT_PUBLIC_SOCKET_URL`, inlined at build time. Kept so an existing dev
 *      `.env` and the e2e build keep working unchanged.
 *   3. `http://localhost:4000` under `next dev` only, where the UI is on :3000 and
 *      the API on :4000.
 *   4. The page's own origin. The Helm ingress routes `/socket.io` to the server,
 *      so a release image needs no configuration at all.
 *
 * Only an http(s) or ws(s) URL is accepted, and only its origin is kept: Socket.IO
 * reads a path in the URL as a NAMESPACE, so `https://host/metis` would silently
 * connect to namespace `/metis` instead of `/`.
 */

/** The API's port under `next dev`; never used by a production build. */
export const DEV_SOCKET_URL = "http://localhost:4000";

/** The global `/runtime-config` assigns before the app hydrates. */
export const RUNTIME_CONFIG_GLOBAL = "__METIS_RUNTIME_CONFIG__";

/** Public path of the runtime-config script (allow-listed in `proxy.ts`). */
export const RUNTIME_CONFIG_PATH = "/runtime-config";

/** Runtime settings the UI server hands the browser. Never secrets. */
export interface RuntimeConfig {
  socketUrl: string | null;
}

const SOCKET_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

/** A DNS name / IPv4 literal, or a bracketed IPv6 literal (as `URL.hostname` prints it). */
const HOSTNAME = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i;

/**
 * The origin of `value` when it is an absolute http(s)/ws(s) URL without
 * credentials, else `null`. Blank, relative, `javascript:` and malformed values
 * are all `null`, so a bad setting falls through to the next source instead of
 * breaking the connection.
 */
export function normalizeSocketUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!SOCKET_PROTOCOLS.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  // WHATWG URL parsing lets `"` and `;` through into a special-scheme host
  // (`https://x.example";alert(1)` parses). No real host needs them, so admit only
  // a DNS name or an IP literal.
  if (!HOSTNAME.test(url.hostname)) return null;
  return url.origin;
}

export interface SocketUrlSources {
  /** From `/runtime-config` (`METIS_BROWSER_SOCKET_URL`). */
  runtimeUrl?: unknown;
  /** `process.env.NEXT_PUBLIC_SOCKET_URL`, as inlined by the build. */
  buildUrl?: unknown;
  /**
   * The `next dev` fallback: `DEV_SOCKET_URL` under `next dev`, else undefined.
   * Decided by the caller from the INLINED `process.env.NODE_ENV`, so a production
   * build folds the branch away and its bundle carries no `localhost:4000` at all.
   */
  devUrl?: string;
  /** `window.location.origin`. */
  origin: string;
}

/** Apply the precedence documented at the top of this file. */
export function resolveSocketUrl(sources: SocketUrlSources): string {
  return (
    normalizeSocketUrl(sources.runtimeUrl) ??
    normalizeSocketUrl(sources.buildUrl) ??
    sources.devUrl ??
    sources.origin
  );
}

/** The runtime config the page was served with, if `/runtime-config` ran. */
export function readRuntimeConfig(): Partial<RuntimeConfig> {
  if (typeof window === "undefined") return {};
  const value = (window as unknown as Record<string, unknown>)[RUNTIME_CONFIG_GLOBAL];
  return value && typeof value === "object" ? (value as Partial<RuntimeConfig>) : {};
}

/** The URL the browser socket dials, resolved at connect time. */
export function browserSocketUrl(): string {
  return resolveSocketUrl({
    runtimeUrl: readRuntimeConfig().socketUrl,
    // Both are inlined by Next at build time; they must be written out in full
    // (`process.env.X`) for the inlining to happen.
    buildUrl: process.env.NEXT_PUBLIC_SOCKET_URL,
    devUrl: process.env.NODE_ENV === "development" ? DEV_SOCKET_URL : undefined,
    origin: window.location.origin,
  });
}

/**
 * The body of `/runtime-config`: one assignment of a JSON literal, built from
 * the UI server's environment at request time. `JSON.stringify` of a value that
 * has already been reduced to a URL origin (or `null`) cannot break out of the
 * expression; `<` is escaped anyway so the body stays inert if it is ever inlined
 * into HTML.
 */
export function runtimeConfigScript(env: Record<string, string | undefined>): string {
  const config: RuntimeConfig = {
    socketUrl: normalizeSocketUrl(env.METIS_BROWSER_SOCKET_URL),
  };
  const json = JSON.stringify(config).replace(/</g, "\\u003c");
  return `window.${RUNTIME_CONFIG_GLOBAL}=${json};\n`;
}
