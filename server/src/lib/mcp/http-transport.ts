/**
 * MCP streamable-http / sse transport.
 *
 * Wraps `fetch` (Node 20+ built-in) with JSON-RPC over POST. The MCP spec uses
 * an `Mcp-Session-Id` header that the server returns on the initialize
 * response and the client must echo on every subsequent request.
 *
 * Hardening (security focus):
 *   - URLs are DNS-resolved at validation time and EVERY resolved IP is
 *     checked against the private/loopback/link-local/ULA deny-list. A public
 *     hostname that resolves to `127.0.0.1` or `169.254.169.254` (cloud
 *     metadata) is REJECTED — the lexical hostname check on its own would
 *     allow DNS rebinding (SEC-1).
 *   - `redirect: "manual"` on every outbound request; on 3xx the `Location`
 *     header is re-validated through the same DNS-pinned guard before being
 *     followed. Maximum 3 hops (SEC-2).
 *   - HTTPS required in production unless the host appears on
 *     `MCP_ALLOWED_HOSTS` or loopback is explicitly enabled.
 *   - The `Origin` header is set to a stable platform value so an MCP server
 *     running locally can compare and reject cross-origin attacks per the spec.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { isPrivateIp } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { safeFetch as canonicalSafeFetch, type SafeFetchResolver } from "../net/safe-fetch.js";
import { SafeFetchPrivateIpError } from "../net/safe-fetch.errors.js";
import type { MCPTransportClient } from "./types.js";

const log = createChildLogger("mcp-http");

// Re-exported so existing tests keep working post-#299. The function lives
// in `packages/shared/src/net/private-ip.ts`.
export { isPrivateIp };

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const PLATFORM_ORIGIN = "metis://server";
const MAX_REDIRECT_HOPS = 3;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** DNS lookup result shape used by `assertSafeUrl`. Tests inject a stub. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}
export type DnsLookupAllFn = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookupAll: DnsLookupAllFn = async (hostname) => {
  const out = await dns.lookup(hostname, { all: true });
  return out.map((r) => ({ address: r.address, family: r.family as 4 | 6 }));
};

export interface HttpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  /** SSE upgrade (text/event-stream). Defaults to false; we only need request/response for tools/list. */
  sseUpgrade?: boolean;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Override DNS lookup for tests. */
  lookupFn?: DnsLookupAllFn;
  /** Skip allow-list check — used only for unit tests. */
  skipHostCheck?: boolean;
}

export class MCPHttpTransport implements MCPTransportClient {
  private nextId = 1;
  private sessionId: string | null = null;
  private started = false;
  private stopped = false;
  private closedDeferred = createDeferred<{ code: number | null; reason: string }>();

  constructor(private readonly opts: HttpTransportOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.opts.skipHostCheck) {
      await assertSafeUrl(this.opts.url, this.opts.lookupFn ?? defaultLookupAll);
    }
    this.started = true;
  }

  async stop(reason = "stop"): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    // If the server gave us a session id, send a delete request per spec.
    if (this.sessionId) {
      try {
        await this.safeFetch(this.opts.url, {
          method: "DELETE",
          headers: this.buildHeaders(),
        });
      } catch (err) {
        log.debug("MCP DELETE on stop failed", {
          url: this.opts.url,
          error: (err as Error).message,
        });
      }
      this.sessionId = null;
    }
    this.closedDeferred.resolve({ code: 0, reason });
  }

  async request<TResult>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    if (this.stopped) throw new Error("MCP transport is stopped");
    if (!this.started) throw new Error("MCP transport has not been started");
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await this.safeFetch(this.opts.url, {
        method: "POST",
        headers: this.buildHeaders(),
        body,
        signal: ctrl.signal,
      });
      // Capture session id on first response (typically initialize).
      const newSession = res.headers.get("mcp-session-id");
      if (newSession && !this.sessionId) {
        this.sessionId = newSession;
      }
      if (!res.ok) {
        throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);
      }
      const text = await res.text();
      if (!text) {
        return undefined as TResult;
      }
      const parsed = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
      const msg = Array.isArray(parsed) ? parsed.find((m) => m.id === id) : parsed;
      if (!msg) {
        throw new Error(`MCP HTTP response had no matching id ${id}`);
      }
      if (msg.error) {
        throw new Error(`MCP error ${msg.error.code}: ${msg.error.message}`);
      }
      return msg.result as TResult;
    } finally {
      clearTimeout(timer);
    }
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (this.stopped) throw new Error("MCP transport is stopped");
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    await this.safeFetch(this.opts.url, {
      method: "POST",
      headers: this.buildHeaders(),
      body,
    });
  }

  async closed(): Promise<{ code: number | null; reason: string }> {
    return this.closedDeferred.promise;
  }

  /** Test helper — current session id, if the server has issued one. */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: this.opts.sseUpgrade ? "application/json, text/event-stream" : "application/json",
      Origin: PLATFORM_ORIGIN,
      ...(this.opts.headers ?? {}),
    };
    if (this.sessionId) h["Mcp-Session-Id"] = this.sessionId;
    return h;
  }

  /**
   * fetch wrapper that pins `redirect: "manual"` and re-validates any 3xx
   * `Location` through `assertSafeUrl` before following. Closes SEC-2.
   *
   * Per-hop transport now goes through the canonical `safeFetch` helper so
   * the IP that `assertSafeUrl` validated is the same IP the undici
   * dispatcher actually connects to. This closes the DNS-rebinding TOCTOU
   * window between validation and the socket connect (#303).
   */
  private async safeFetch(url: string, init: RequestInit): Promise<Response> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const lookupFn = this.opts.lookupFn ?? defaultLookupAll;
    // When tests set `skipHostCheck`, force the resolver to return a fixed
    // public IP so the canonical safeFetch pipeline does not block on real
    // DNS for the synthetic test hostnames.
    const resolverAdapter: SafeFetchResolver = this.opts.skipHostCheck
      ? async () => [{ address: "203.0.113.10", family: 4 }]
      : lookupFn;
    let current = url;
    let currentInit: RequestInit = { ...init, redirect: "manual" };
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const allowedSet = new Set<string>([
        ...readAllowedHosts(),
        // skipHostCheck (used only in tests) opts the current target into
        // the allow-list so the canonical pipeline does not duplicate the
        // assertSafeUrl rejection. Production callers never set this flag.
        ...(this.opts.skipHostCheck ? [new URL(current).hostname.toLowerCase()] : []),
      ]);
      let res: Response;
      try {
        res = await canonicalSafeFetch(current, {
          ...currentInit,
          redirect: "manual",
          fetchImpl: fetchFn,
          resolver: resolverAdapter,
          allowedHosts: allowedSet,
          allowLoopback: this.opts.skipHostCheck || allowsLoopback(),
          // No-op dispatcher when tests override fetchFn; otherwise canonical
          // safeFetch builds an undici Agent pinned to the validated IP.
          dispatcherFactory: this.opts.fetchFn
            ? async () => ({ close: async () => undefined })
            : undefined,
        });
      } catch (err) {
        if (err instanceof SafeFetchPrivateIpError) {
          // Preserve the legacy error message that existing tests pin on.
          throw new Error(
            `MCP HTTP url ${current} resolves to private/loopback address ${err.address} — refusing to bypass deny-list (SSRF guard)`,
          );
        }
        throw err;
      }
      if (res.status < 300 || res.status >= 400) return res;
      const location = res.headers.get("location");
      if (!location) return res;
      if (hop === MAX_REDIRECT_HOPS) {
        throw new Error(`MCP HTTP exceeded redirect hop limit (${MAX_REDIRECT_HOPS})`);
      }
      const next = new URL(location, current).toString();
      // Re-validate every redirect target — an allow-listed origin can
      // otherwise 302 → metadata service. This is the SEC-2 fix.
      if (!this.opts.skipHostCheck) {
        await assertSafeUrl(next, lookupFn);
      }
      // 303 forces GET with no body; otherwise body is preserved.
      if (res.status === 303) {
        currentInit = { ...currentInit, method: "GET", body: undefined };
      }
      current = next;
    }
    // Unreachable — loop returns or throws.
    throw new Error("MCP HTTP redirect loop exited without response");
  }
}

/**
 * DNS-pinned URL validation. Resolves `raw`'s hostname to ALL addresses, then
 * rejects if any address is in a private / loopback / link-local / ULA range,
 * unless the hostname OR resolved address is on `MCP_ALLOWED_HOSTS`. Closes
 * SEC-1: a public hostname that points at `127.0.0.1` or `169.254.169.254`
 * (cloud metadata) is rejected even though the lexical name looks safe.
 *
 * Also enforces the production HTTPS / loopback policy.
 */
export async function assertSafeUrl(raw: string, lookup: DnsLookupAllFn): Promise<URL> {
  const parsed = parseAndCheckScheme(raw);
  const host = parsed.hostname.toLowerCase();
  const allowed = readAllowedHosts();
  const onAllowList = allowed.includes(host);
  const isLoopbackHost = isLoopbackName(host);

  if (process.env.NODE_ENV === "production") {
    if (parsed.protocol !== "https:" && !isLoopbackHost && !onAllowList) {
      throw new Error(`MCP HTTP url must use HTTPS in production: ${raw}`);
    }
    if (isLoopbackHost && !onAllowList && process.env.MCP_ALLOW_LOOPBACK !== "1") {
      throw new Error(
        `MCP HTTP url targets loopback in production. Set MCP_ALLOW_LOOPBACK=1 to permit.`,
      );
    }
  }

  // If the host is already an IP literal, validate it directly without DNS.
  const ipFamily = isIP(stripBrackets(host));
  if (ipFamily !== 0) {
    const ip = stripBrackets(host);
    if (isPrivateIp(ip) && !onAllowList && !(isLoopbackHost && allowsLoopback())) {
      throw new Error(`MCP HTTP url targets a private host without MCP_ALLOWED_HOSTS entry: ${ip}`);
    }
    return parsed;
  }

  // Loopback hostnames bypass DNS — `localhost` may resolve to 127.0.0.1 / ::1
  // which we permit through MCP_ALLOW_LOOPBACK. An explicit allow-list entry
  // for the hostname still requires a DNS check (handled below).
  if (isLoopbackHost && (onAllowList || allowsLoopback())) return parsed;

  // DNS pinning — every resolved address must be public unless allow-listed.
  let addrs: ResolvedAddress[];
  try {
    addrs = await lookup(host);
  } catch (err) {
    throw new Error(`MCP HTTP url DNS lookup failed for ${host}: ${(err as Error).message}`);
  }
  if (!addrs || addrs.length === 0) {
    throw new Error(`MCP HTTP url DNS lookup returned no addresses for ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address) && !onAllowList && !allowed.includes(a.address.toLowerCase())) {
      throw new Error(
        `MCP HTTP url ${raw} resolves to private/loopback address ${a.address} — refusing to bypass deny-list (SSRF guard)`,
      );
    }
  }
  return parsed;
}

/**
 * Lexical-only URL validation kept for backward compatibility with callers
 * that need a synchronous check (and the existing test suite). Real network
 * traffic always goes through `assertSafeUrl`.
 */
export function validateUrl(raw: string): void {
  const parsed = parseAndCheckScheme(raw);
  const host = parsed.hostname.toLowerCase();
  const allowed = readAllowedHosts();
  const onAllowList = allowed.includes(host);
  const isLoopbackHost = isLoopbackName(host);

  if (process.env.NODE_ENV === "production") {
    if (parsed.protocol !== "https:" && !isLoopbackHost && !onAllowList) {
      throw new Error(`MCP HTTP url must use HTTPS in production: ${raw}`);
    }
    if (isLoopbackHost && !onAllowList && process.env.MCP_ALLOW_LOOPBACK !== "1") {
      throw new Error(
        `MCP HTTP url targets loopback in production. Set MCP_ALLOW_LOOPBACK=1 to permit.`,
      );
    }
  }
  // Lexical private-host check (string heuristic, NOT DNS).
  if (!onAllowList && !isLoopbackHost && isPrivateHostnameLexical(host)) {
    throw new Error(`MCP HTTP url targets a private host without MCP_ALLOWED_HOSTS entry: ${host}`);
  }
}

function parseAndCheckScheme(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`MCP HTTP url is not a valid URL: ${raw}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`MCP HTTP url uses unsupported protocol: ${parsed.protocol}`);
  }
  return parsed;
}

function readAllowedHosts(): string[] {
  return (process.env.MCP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function allowsLoopback(): boolean {
  return process.env.MCP_ALLOW_LOOPBACK === "1" || process.env.NODE_ENV !== "production";
}

function isLoopbackName(host: string): boolean {
  const h = stripBrackets(host);
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0";
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

/** String-heuristic check used by lexical `validateUrl`. */
function isPrivateHostnameLexical(host: string): boolean {
  const h = stripBrackets(host);
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  return false;
}

// `isPrivateIp` was lifted to `packages/shared/src/net/private-ip.ts` in
// #299; this module re-exports it (above) for backwards compatibility.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolveFn = res;
  });
  return { promise, resolve: resolveFn };
}
