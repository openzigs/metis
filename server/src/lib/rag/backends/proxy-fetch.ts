/**
 * Proxy-aware fetch for the remote embeddings backends (Epic #930).
 *
 * Firewalled / air-gapped deployments are the primary audience for the cloud
 * embedding backends (Bedrock gateway #932, OpenAI / Azure #934). Those
 * clients almost always reach the public internet through a forward proxy.
 * Node's global `fetch` (undici) does NOT honour `HTTP(S)_PROXY` unless an
 * explicit `dispatcher` is supplied, so without this helper the backends would
 * silently bypass the proxy and fail in exactly the environments that need
 * them most.
 *
 * This wraps the base fetch and, when the standard proxy env vars apply to the
 * target URL, routes the request through an undici `ProxyAgent` dispatcher.
 * The selection logic mirrors the de-facto `HTTPS_PROXY` / `HTTP_PROXY` /
 * `NO_PROXY` convention used by curl, git, and the rest of the toolchain.
 *
 * The undici import is lazy (`import('undici')`) so test environments that mock
 * the transport never need a real dispatcher.
 */
import type { FetchLike } from "./http.js";

export interface ProxyEnvLike {
  HTTP_PROXY?: string;
  http_proxy?: string;
  HTTPS_PROXY?: string;
  https_proxy?: string;
  NO_PROXY?: string;
  no_proxy?: string;
  [key: string]: string | undefined;
}

/** Test seam — async factory that yields an undici-compatible dispatcher. */
export type DispatcherFactory = (proxyUrl: string) => Promise<unknown> | unknown;

export interface CreateProxyFetchOptions {
  /** Defaults to `process.env`. */
  env?: ProxyEnvLike;
  /** Underlying transport — defaults to global `fetch`. */
  baseFetch?: FetchLike;
  /** Overrides the undici `ProxyAgent` factory entirely (tests). */
  dispatcherFactory?: DispatcherFactory;
}

function readEnv(env: ProxyEnvLike, upper: string, lower: string): string | undefined {
  const v = env[upper] ?? env[lower];
  const trimmed = v?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve the proxy URL that applies to `targetUrl` based on its scheme:
 * https targets use `HTTPS_PROXY`, http targets use `HTTP_PROXY`. Returns
 * undefined when no proxy is configured for the scheme. Does NOT consider
 * `NO_PROXY` — see {@link shouldBypassProxy}.
 */
export function selectProxyUrl(targetUrl: string, env: ProxyEnvLike): string | undefined {
  let protocol: string;
  try {
    protocol = new URL(targetUrl).protocol;
  } catch {
    return undefined;
  }
  if (protocol === "https:") {
    return readEnv(env, "HTTPS_PROXY", "https_proxy");
  }
  if (protocol === "http:") {
    return readEnv(env, "HTTP_PROXY", "http_proxy");
  }
  return undefined;
}

/**
 * Returns true when `targetUrl`'s host matches the `NO_PROXY` bypass list.
 * Supports `*` (bypass everything), exact host match, and suffix matching with
 * an optional leading dot / wildcard (`.example.com`, `*.example.com`).
 */
export function shouldBypassProxy(targetUrl: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const entries = noProxy
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) return false;
  if (entries.includes("*")) return true;

  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }

  for (const raw of entries) {
    // Strip a leading wildcard / dot and any port suffix from the entry.
    const entryHost = raw.replace(/^\*?\.?/, "").split(":")[0];
    if (!entryHost) continue;
    if (host === entryHost || host.endsWith(`.${entryHost}`)) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the effective proxy URL for `targetUrl`, accounting for both the
 * scheme-specific proxy var and the `NO_PROXY` bypass list. Returns undefined
 * when the request should go direct.
 */
export function getProxyDispatcherUrl(targetUrl: string, env: ProxyEnvLike): string | undefined {
  const proxyUrl = selectProxyUrl(targetUrl, env);
  if (!proxyUrl) return undefined;
  if (shouldBypassProxy(targetUrl, readEnv(env, "NO_PROXY", "no_proxy"))) {
    return undefined;
  }
  return proxyUrl;
}

const dispatcherCache = new Map<string, unknown>();

async function defaultDispatcherFactory(proxyUrl: string): Promise<unknown> {
  const cached = dispatcherCache.get(proxyUrl);
  if (cached) return cached;
  const undici = (await import("undici")) as unknown as {
    ProxyAgent: new (uri: string) => unknown;
  };
  const agent = new undici.ProxyAgent(proxyUrl);
  dispatcherCache.set(proxyUrl, agent);
  return agent;
}

/**
 * Build a {@link FetchLike} that transparently routes through a proxy
 * dispatcher when `HTTP(S)_PROXY` applies to the target and `NO_PROXY` does not
 * exempt it. Otherwise it delegates straight to the base fetch.
 */
export function createProxyFetch(opts: CreateProxyFetchOptions = {}): FetchLike {
  const env = opts.env ?? (process.env as ProxyEnvLike);
  const baseFetch = opts.baseFetch ?? (globalThis.fetch as FetchLike | undefined);
  const dispatcherFactory = opts.dispatcherFactory ?? defaultDispatcherFactory;

  return async (input: string, init: RequestInit): Promise<Response> => {
    if (!baseFetch) {
      throw new Error("global fetch is unavailable in this runtime");
    }
    const proxyUrl = getProxyDispatcherUrl(input, env);
    if (!proxyUrl) {
      return baseFetch(input, init);
    }
    const dispatcher = await dispatcherFactory(proxyUrl);
    // undici's fetch accepts a `dispatcher` on init; the DOM RequestInit type
    // does not model it, so widen locally rather than globally.
    return baseFetch(input, { ...init, dispatcher } as RequestInit & { dispatcher: unknown });
  };
}

/** Clears the memoised dispatcher cache — exported for tests. */
export function __resetProxyDispatcherCache(): void {
  dispatcherCache.clear();
}
