import { API_BASE } from "./config";

/** Strongly-typed error shape thrown by the API client. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;

  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** JSON-encoded automatically. Pass a plain object or array. */
  body?: unknown;
  /** Query string params. */
  params?: Record<string, string | number | boolean | undefined>;
  /** Internal: skip the 401 → refresh → retry dance (used by the refresh call itself). */
  _skipAuthRetry?: boolean;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string; details?: unknown };
}

// ---------------------------------------------------------------------------
// 401 taxonomy (#412, epic #404).
//
// A 401 status alone is ambiguous: it can mean "your session expired, refresh
// it" (auth-expiry) OR — when an endpoint returns 401 for a permission denial —
// "you are authenticated but not allowed here" (authz). Treating EVERY 401 as
// session-expiry wrongly logs out a user who merely hit a resource they lack
// rights to. We therefore branch on the stable `error.code` the server emits in
// the `{ success, error: { code } }` envelope, NOT on status alone.
//
// Server contract (verified against server/src/middleware/*.ts):
//   • Auth-expiry / not-authenticated 401s carry codes like AUTH_REQUIRED,
//     TOKEN_EXPIRED, TOKEN_INVALID — these are refresh-eligible.
//   • Authorization (permission) denials are emitted as 403 FORBIDDEN today,
//     never as 401. We still defend against a 401 that carries an authz code so
//     a future endpoint (or a proxy that rewrites 403→401) cannot boot the user.
//
// Default-on-unknown: a 401 whose code is NOT a recognized authz denial stays
// refresh-eligible. Rationale (OWASP A01 — never weaken auth): a bare 401 means
// "not authenticated", so the safe behaviour is to attempt refresh and, on a
// genuine refresh failure, log out — exactly as before. Only an explicit authz
// code opts a 401 OUT of the refresh/logout path.
// ---------------------------------------------------------------------------

/** Stable error codes that mark a 401 as an authorization denial (NOT auth-expiry). */
const AUTHZ_401_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "INSUFFICIENT_SCOPE"]);

/**
 * True when a 401 should be surfaced to the caller as a normal authorization
 * failure (like a 403) instead of triggering refresh → retry → logout.
 * Keyed off the envelope `error.code`, never the status alone.
 */
function isAuthzDenialCode(code: string | undefined): boolean {
  return code !== undefined && AUTHZ_401_CODES.has(code);
}

function buildUrl(path: string, params?: ApiFetchOptions["params"]): string {
  const base = path.startsWith("/") ? `${API_BASE}${path}` : `${API_BASE}/${path}`;
  if (!params) return base;
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return qs ? `${base}?${qs}` : base;
}

// ---------------------------------------------------------------------------
// 401 → refresh → retry coordination.
// A single in-flight refresh promise coalesces concurrent 401s so we only ever
// hit `/auth/refresh` once per token-expiry event. On success, all queued
// callers retry their original request once. On failure, every caller sees the
// original 401 surfaced as an ApiError.
// ---------------------------------------------------------------------------

let inFlightRefresh: Promise<boolean> | null = null;
type RefreshFailureHandler = () => void;
let onRefreshFailure: RefreshFailureHandler | null = null;

type RefreshSuccessHandler = () => void;
let onRefreshSuccess: RefreshSuccessHandler | null = null;

/** Register a callback fired when a refresh attempt fails (e.g. logout + redirect). */
export function setOnRefreshFailure(handler: RefreshFailureHandler | null): void {
  onRefreshFailure = handler;
}

/**
 * Register a callback fired when an access-token refresh SUCCEEDS (#414).
 *
 * This is the seam the socket-client subscribes to: when the 1h `metis.at`
 * access cookie is renewed, the socket must re-handshake so its next connection
 * carries the FRESH cookie (socket.io authenticates ONCE at the handshake and
 * its auto-reconnect re-sends the SAME stale cookie otherwise). Mirror of
 * {@link setOnRefreshFailure}. Fires from the single `refreshOnce` choke point,
 * so it covers BOTH the reactive 401 retry path AND the proactive
 * sliding-session timer (#410) uniformly, with no extra `/auth/refresh` calls.
 */
export function setOnRefreshSuccess(handler: RefreshSuccessHandler | null): void {
  onRefreshSuccess = handler;
}

/** Test seam — reset module-level state between specs. */
export function _resetAuthRetryState(): void {
  inFlightRefresh = null;
  onRefreshFailure = null;
  onRefreshSuccess = null;
}

/**
 * Public, single-flight access-token refresh trigger.
 *
 * Thin wrapper over the module-private {@link refreshOnce} so callers OUTSIDE
 * the reactive 401 path (notably the proactive sliding-session timer in
 * `auth-context.tsx`, #410) can renew the access token BEFORE expiry. Because it
 * delegates to the SAME `inFlightRefresh` single-flight promise used by the
 * reactive 401 retry, a proactive refresh can never race / double-refresh
 * against a concurrent reactive refresh — they coalesce onto one `/auth/refresh`
 * call. Resolves `true` when the refresh succeeded, `false` otherwise (the
 * caller decides whether to re-hydrate `/auth/me` or treat it as a logout).
 */
export async function refreshAccessToken(): Promise<boolean> {
  return refreshOnce();
}

async function refreshOnce(): Promise<boolean> {
  if (!inFlightRefresh) {
    inFlightRefresh = (async () => {
      try {
        const response = await fetch(buildUrl("/auth/refresh"), {
          method: "POST",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (response.ok) {
          // #414 — single place every successful refresh flows through. Notify
          // subscribers (the socket-client re-handshakes with the fresh cookie)
          // BEFORE returning. A throwing subscriber must NOT break the refresh
          // promise, so guard it. There is no token to log here — it rides the
          // `metis.at` cookie — but per OWASP never log token material either.
          try {
            onRefreshSuccess?.();
          } catch {
            /* swallow — a faulty subscriber cannot fail the refresh */
          }
        }
        return response.ok;
      } catch {
        return false;
      }
    })().finally(() => {
      // Clear after the current promise settles so a subsequent expiry triggers
      // a fresh refresh, but every concurrent caller awaiting *this* promise
      // observes the same result.
      queueMicrotask(() => {
        inFlightRefresh = null;
      });
    });
  }
  return inFlightRefresh;
}

/**
 * Read the `error.code` from a (typically 401) response WITHOUT consuming the
 * body the caller may still need. Clones the response first; a clone whose
 * body cannot be parsed yields `undefined` (treated as "no recognized code").
 * Used by {@link streamFetch} to classify 401s, since it returns the raw
 * `Response` and never buffers the body itself.
 */
async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const text = await response.clone().text();
    if (!text) return undefined;
    const payload = JSON.parse(text) as ApiEnvelope<unknown>;
    return payload?.error?.code;
  } catch {
    return undefined;
  }
}

interface DoFetchResult<T> {
  response: Response;
  payload: ApiEnvelope<T> | undefined;
}

async function doFetch<T>(path: string, options: ApiFetchOptions): Promise<DoFetchResult<T>> {
  const { body, params, headers, _skipAuthRetry: _skip, ...init } = options;
  void _skip;
  const url = buildUrl(path, params);

  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let payload: ApiEnvelope<T> | undefined;
  const text = await response.text();
  if (text) {
    try {
      payload = JSON.parse(text) as ApiEnvelope<T>;
    } catch {
      // Non-JSON response — leave payload undefined.
    }
  }

  return { response, payload };
}

/**
 * Issue a request through the Next.js auth proxy. Always sends cookies and
 * normalizes upstream `{ success, data, error }` envelopes into either the
 * unwrapped data payload or a thrown `ApiError`.
 *
 * On a 401, the client transparently calls `/auth/refresh` once and retries the
 * original request a single time. Concurrent 401s share one refresh call. If
 * the refresh fails (or the retry also returns 401), the 401 is surfaced and
 * the optional `onRefreshFailure` callback is invoked so the app can log out.
 */
export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  let { response, payload } = await doFetch<T>(path, options);

  // #412 — an authz (permission) 401 must surface like a 403: no refresh, no
  // logout. Only auth-expiry 401s enter the refresh → retry → logout path.
  const shouldRetry =
    response.status === 401 &&
    !isAuthzDenialCode(payload?.error?.code) &&
    !options._skipAuthRetry &&
    path !== "/auth/refresh" &&
    path !== "/auth/login" &&
    path !== "/auth/logout";

  if (shouldRetry) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      ({ response, payload } = await doFetch<T>(path, { ...options, _skipAuthRetry: true }));
      if (response.status === 401) {
        onRefreshFailure?.();
      }
    } else {
      onRefreshFailure?.();
    }
  }

  if (!response.ok || (payload && payload.success === false)) {
    const message = payload?.error?.message ?? response.statusText ?? "Request failed";
    // Most errors carry structured data under `error.details`. Some endpoints
    // (e.g. the optimistic-lock 409) attach conflict fields directly on the
    // `error` object instead — fall back to the whole error payload so callers
    // (the 3-way merge flow) can still read `serverVersion`/`diff`.
    const details = payload?.error?.details ?? payload?.error;
    throw new ApiError(response.status, message, payload?.error?.code, details);
  }

  if (payload && "data" in payload) {
    return payload.data as T;
  }
  return undefined as T;
}

/**
 * Stream-friendly fetch that reuses {@link apiFetch}'s 401 → refresh → retry
 * chain WITHOUT consuming the response body. Returns the raw `Response` so
 * the caller can drive `.body.getReader()` for SSE/streaming endpoints.
 *
 * Behaviour:
 *   • Issues the request through the Next.js auth proxy with cookies.
 *   • On a 401, calls `/auth/refresh` once (single-flight, shared with
 *     `apiFetch`), then retries the original request once.
 *   • If the refresh fails or the retry still 401s, fires the registered
 *     `onRefreshFailure` handler so the app can boot the user back to login.
 *   • All other status codes are returned as-is — the caller decides how to
 *     surface upstream errors (typically by reading `await res.json()` for
 *     non-OK responses).
 *
 * The streaming `body` is left intact on the returned `Response` so callers
 * can iterate it. Do NOT call `.text()` / `.json()` on a successful response
 * — those would buffer the entire stream into memory.
 */
export async function streamFetch(
  path: string,
  init: RequestInit & { params?: ApiFetchOptions["params"] } = {},
): Promise<Response> {
  const { params, ...requestInit } = init;
  const url = buildUrl(path, params);
  const baseInit: RequestInit = {
    ...requestInit,
    credentials: "same-origin",
  };

  let response = await fetch(url, baseInit);

  const isRetryablePath =
    path !== "/auth/refresh" && path !== "/auth/login" && path !== "/auth/logout";

  // #412 — classify the 401 the same way apiFetch does. A 401 body is an error
  // envelope (never a live stream), so we clone it to read the code WITHOUT
  // disturbing the response the caller may still want to read. An authz 401 is
  // returned untouched (no refresh, no logout); only an auth-expiry 401 retries.
  let shouldRetry = response.status === 401 && isRetryablePath;
  if (shouldRetry) {
    const code = await readErrorCode(response);
    if (isAuthzDenialCode(code)) {
      shouldRetry = false;
    }
  }

  if (shouldRetry) {
    const refreshed = await refreshOnce();
    if (refreshed) {
      // Discard the original 401 body so the underlying socket can be reused.
      try {
        await response.body?.cancel();
      } catch {
        /* already closed */
      }
      response = await fetch(url, baseInit);
      if (response.status === 401) {
        onRefreshFailure?.();
      }
    } else {
      onRefreshFailure?.();
    }
  }

  return response;
}
