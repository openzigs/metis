/**
 * #1069 — the `/api/*` proxy's upstream timeout for Spec Kit commands.
 *
 * A Spec Kit command holds its request open for the whole model call, and the
 * proxy's `fetch` gave up after undici's default 300 s `headersTimeout` while
 * the server went on to save the artifact. Only those routes get the longer
 * timeout; every other route keeps the default. Stopgap for #1059, which makes
 * the commands background jobs.
 *
 * Server-only: imported by the route handler, never by a client component.
 */
import { Agent, fetch as undiciFetch } from "undici";

/** Env var (milliseconds) that overrides {@link SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS}. */
export const SPEC_KIT_PROXY_TIMEOUT_ENV = "METIS_SPEC_KIT_PROXY_TIMEOUT_MS";
/** 15 minutes. */
export const SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS = 15 * 60_000;
/** undici's own default: a lower value would time out sooner than no override at all. */
export const SPEC_KIT_PROXY_TIMEOUT_MIN_MS = 5 * 60_000;
/** 60 minutes — a held request is never unbounded. */
export const SPEC_KIT_PROXY_TIMEOUT_MAX_MS = 60 * 60_000;

/**
 * True for `POST /projects/:id/spec-kit/commands/:cmd` — `path` is the
 * catch-all's segments, without the `/api` prefix. Exact segments only, so a
 * near miss falls back to the default timeout.
 */
export function isSpecKitCommandRequest(method: string, path: readonly string[]): boolean {
  return (
    method.toUpperCase() === "POST" &&
    path.length === 5 &&
    path[0] === "projects" &&
    path[1] !== "" &&
    path[2] === "spec-kit" &&
    path[3] === "commands" &&
    path[4] !== ""
  );
}

/**
 * The timeout in milliseconds: the env value clamped to
 * [{@link SPEC_KIT_PROXY_TIMEOUT_MIN_MS}, {@link SPEC_KIT_PROXY_TIMEOUT_MAX_MS}],
 * or the default when it is unset or not a whole number of milliseconds.
 */
export function resolveSpecKitProxyTimeoutMs(raw: string | undefined): number {
  const text = raw?.trim() ?? "";
  if (!/^\d+$/.test(text)) return SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS;
  return Math.min(
    SPEC_KIT_PROXY_TIMEOUT_MAX_MS,
    Math.max(SPEC_KIT_PROXY_TIMEOUT_MIN_MS, Number(text)),
  );
}

/**
 * A `fetch` that waits up to `timeoutMs` for the response headers and between
 * body chunks.
 *
 * It is undici's own `fetch`, not the global one: Node's built-in `fetch`
 * rejects a dispatcher from a different undici version with
 * `UND_ERR_INVALID_ARG` (measured on Node 22.22 with undici 7 and 8), so the
 * dispatcher and the `fetch` have to come from the same package.
 */
export function createLongTimeoutFetch(timeoutMs: number): typeof fetch {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
  const longFetch = (input: Parameters<typeof undiciFetch>[0], init?: object) =>
    undiciFetch(input, { ...init, dispatcher });
  return longFetch as unknown as typeof fetch;
}

let specKitFetch: typeof fetch | undefined;

/** The proxy's `fetch` for a Spec Kit command; the agent is built once, on first use. */
export function specKitCommandFetch(): typeof fetch {
  specKitFetch ??= createLongTimeoutFetch(
    resolveSpecKitProxyTimeoutMs(process.env[SPEC_KIT_PROXY_TIMEOUT_ENV]),
  );
  return specKitFetch;
}

/** Test seam — forget the cached agent so the env var is read again. */
export function _resetSpecKitCommandFetch(): void {
  specKitFetch = undefined;
}
