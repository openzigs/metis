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
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit } from "undici";
import { isDotSegment } from "@/lib/proxy-upstream";

/** Env var (milliseconds) that overrides {@link SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS}. */
export const SPEC_KIT_PROXY_TIMEOUT_ENV = "METIS_SPEC_KIT_PROXY_TIMEOUT_MS";
/** 15 minutes. */
export const SPEC_KIT_PROXY_TIMEOUT_DEFAULT_MS = 15 * 60_000;
/** undici's own default: a lower value would time out sooner than no override at all. */
export const SPEC_KIT_PROXY_TIMEOUT_MIN_MS = 5 * 60_000;
/** 60 minutes — a held request is never unbounded. */
export const SPEC_KIT_PROXY_TIMEOUT_MAX_MS = 60 * 60_000;

/**
 * Upstream sockets the long-timeout agent holds at once. A command can pin its
 * socket for the whole timeout, so without a cap every concurrent command (or
 * every request to a stuck upstream) held one more. The 17th waits in the
 * agent's queue until a socket frees or its client disconnects.
 */
export const SPEC_KIT_PROXY_MAX_CONNECTIONS = 16;

/**
 * True for `POST <base>/projects/:id/spec-kit/commands/:cmd`.
 *
 * `pathBelowBase` is the RESOLVED upstream path below the base
 * (`pathBelowUpstreamBase`), not the catch-all's raw segments: Next decodes
 * each segment, so a raw segment can hold `/` and name another route once
 * `new URL` has normalised it. Exactly five non-empty segments, none of them a
 * dot segment, so a near miss falls back to the default timeout.
 */
export function isSpecKitCommandRequest(method: string, pathBelowBase: string): boolean {
  if (method.toUpperCase() !== "POST") return false;
  const path = pathBelowBase.split("/");
  return (
    path.length === 5 &&
    path[0] === "projects" &&
    path[1] !== "" &&
    !isDotSegment(path[1]!) &&
    path[2] === "spec-kit" &&
    path[3] === "commands" &&
    path[4] !== "" &&
    !isDotSegment(path[4]!)
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

/** What the proxy sends upstream: the standard init, with a streamed body. */
export type UpstreamRequestInit = RequestInit & { duplex?: "half" };

/** The part of a fetch response the proxy reads. */
export interface UpstreamResponse {
  readonly status: number;
  readonly headers: { forEach(callback: (value: string, key: string) => void): void };
  readonly body: ReadableStream | null;
}

/** The one call the proxy makes; the global `fetch` and undici's both satisfy it. */
export type UpstreamFetch = (url: URL, init: UpstreamRequestInit) => Promise<UpstreamResponse>;

/**
 * A `fetch` that waits up to `timeoutMs` for the response headers and between
 * body chunks, over at most {@link SPEC_KIT_PROXY_MAX_CONNECTIONS} sockets.
 *
 * It is undici's own `fetch`, not the global one: Node's built-in `fetch`
 * rejects a dispatcher from a different undici version with
 * `UND_ERR_INVALID_ARG` (measured on Node 22.22 with undici 7 and 8), so the
 * dispatcher and the `fetch` have to come from the same package.
 */
export function createLongTimeoutFetch(timeoutMs: number): UpstreamFetch {
  const dispatcher = new Agent({
    headersTimeout: timeoutMs,
    bodyTimeout: timeoutMs,
    connections: SPEC_KIT_PROXY_MAX_CONNECTIONS,
  });
  // undici declares its own Headers, ReadableStream and AbortSignal types. At
  // run time they are Node's globals (covered against a real socket in the
  // tests), so the two casts name the same classes; everything else is checked.
  return async (url, init) => {
    const res = await undiciFetch(url, { ...(init as UndiciRequestInit), dispatcher });
    return { status: res.status, headers: res.headers, body: res.body as ReadableStream | null };
  };
}

let specKitFetch: UpstreamFetch | undefined;

/** The proxy's `fetch` for a Spec Kit command; the agent is built once, on first use. */
export function specKitCommandFetch(): UpstreamFetch {
  specKitFetch ??= createLongTimeoutFetch(
    resolveSpecKitProxyTimeoutMs(process.env[SPEC_KIT_PROXY_TIMEOUT_ENV]),
  );
  return specKitFetch;
}

/** Test seam — forget the cached agent so the env var is read again. */
export function _resetSpecKitCommandFetch(): void {
  specKitFetch = undefined;
}
