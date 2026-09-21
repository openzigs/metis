/**
 * Issue #302 — Canonical `safeFetch(url, options)`.
 *
 * The single, authoritative outbound-HTTP helper for every METIS subsystem.
 * Defeats DNS-rebinding TOCTOU SSRF by:
 *
 *   1. Validating the URL scheme (`http:` or `https:` only).
 *   2. Resolving every A/AAAA record up-front. If ANY record is in a
 *      non-routable range (RFC1918 / loopback / link-local / ULA / multicast
 *      / IETF docs / IPv4-mapped-IPv6 of any of the above) the request is
 *      refused — fail closed.
 *   3. Building an undici `Agent` whose `connect.lookup` callback always
 *      returns the FIRST validated IP. The kernel cannot perform a second
 *      DNS lookup between validation and `connect()`, so an attacker
 *      controlling the DNS response cannot smuggle a private IP into the
 *      socket layer (the graphify v0.5.4 fix lifted into this repo).
 *   4. Following redirects manually (off by default — set `redirect:'follow'`
 *      to enable). On 3xx the new `Location` is re-validated through the
 *      same pipeline; cross-origin redirects rebuild the dispatcher with
 *      the new pinned IP.
 *
 * Callers that need an additional allow-list (e.g. MCP_ALLOWED_HOSTS lets a
 * specific hostname resolve to RFC1918) pass `allowedHosts: Set<string>` —
 * lookups for hosts in that set short-circuit the private-IP check but
 * still go through DNS pinning.
 *
 * The reference pre-existing pattern lives in
 * `server/src/lib/scheduler/webhook-handler.ts#makePinnedDispatcher`; this
 * helper is a generalisation of it that the rest of the server can adopt.
 */
import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import { classifyPrivateIp, isLoopbackHostname, isPrivateIp } from "@metis/shared";
import {
  SafeFetchDnsError,
  SafeFetchPrivateIpError,
  SafeFetchRedirectError,
  SafeFetchSchemeError,
  SafeFetchUrlError,
} from "./safe-fetch.errors.js";

/** DNS lookup result shape consumed by the resolver injection point. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type SafeFetchResolver = (host: string) => Promise<ResolvedAddress[]>;

/** Undici `Dispatcher`-shaped subset that we touch. */
export interface DispatcherLike {
  close?(): Promise<void>;
  destroy?(err?: Error): Promise<void>;
}

export type DispatcherFactory = (pinned: ResolvedAddress) => Promise<DispatcherLike>;

export interface SafeFetchOptions extends Omit<RequestInit, "redirect" | "dispatcher"> {
  /**
   * `'error'` (default) — any 3xx response throws `SafeFetchRedirectError`.
   * `'follow'` — redirects are followed up to `maxRedirects`, with each hop
   * re-validated through the same SSRF pipeline.
   * `'manual'` — 3xx responses are returned as-is so the caller can handle
   * the Location header itself. The caller is responsible for re-validating
   * any subsequent hop through `safeFetch`.
   */
  redirect?: "error" | "follow" | "manual";
  /** Maximum redirect hops when `redirect:'follow'`. Default 3. */
  maxRedirects?: number;
  /** Override DNS resolver (test injection). */
  resolver?: SafeFetchResolver;
  /** Override the undici dispatcher factory (test injection). */
  dispatcherFactory?: DispatcherFactory;
  /** Override `globalThis.fetch` (test injection). */
  fetchImpl?: typeof fetch;
  /**
   * Lower-cased hostnames that are exempt from the private-IP check. DNS
   * pinning still applies to these — we just skip the "any private =>
   * reject" step. Use this for caller-level allow-lists like
   * `MCP_ALLOWED_HOSTS`.
   */
  allowedHosts?: ReadonlySet<string>;
  /**
   * Allow loopback names (`localhost`, `127.0.0.1`, `::1`) to bypass the
   * private check. Off by default. Pair with `allowedHosts` for a strict
   * production policy.
   */
  allowLoopback?: boolean;
}

const DEFAULT_MAX_REDIRECTS = 3;

const defaultResolver: SafeFetchResolver = async (host) => {
  const all = await dns.lookup(host, { all: true, verbatim: true });
  return all.map((r) => ({
    address: r.address,
    family: (r.family === 6 ? 6 : 4) as 4 | 6,
  }));
};

/**
 * Build an undici `Agent` that pins every connection for ANY hostname to the
 * already-validated IP. This is the load-bearing part of the SSRF fix —
 * once the dispatcher is built, the kernel cannot do a fresh DNS lookup.
 *
 * `undici` is loaded via `import('undici')` so this file does not require
 * the dependency at module-load time (some test envs mock `fetch` and never
 * exercise the dispatcher).
 */
const defaultDispatcherFactory: DispatcherFactory = async (pinned) => {
  const fam = pinned.family;
  const lookup = (
    _hostname: string,
    _options: unknown,
    cb: (err: Error | null, address: string, family: number) => void,
  ): void => {
    cb(null, pinned.address, fam);
  };
  const undici = (await import("undici")) as unknown as {
    Agent: new (opts: { connect: { lookup: typeof lookup } }) => DispatcherLike;
  };
  return new undici.Agent({ connect: { lookup } });
};

interface ValidatedTarget {
  url: URL;
  pinned: ResolvedAddress;
}

async function validateTarget(raw: string | URL, opts: SafeFetchOptions): Promise<ValidatedTarget> {
  let parsed: URL;
  try {
    parsed = raw instanceof URL ? raw : new URL(raw);
  } catch {
    throw new SafeFetchUrlError(typeof raw === "string" ? raw : String(raw));
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SafeFetchSchemeError(parsed.protocol.replace(/:$/, ""), parsed.toString());
  }

  const host = parsed.hostname.toLowerCase();
  const onAllowList = opts.allowedHosts?.has(host) ?? false;
  const isLoopback = isLoopbackHostname(host);

  // IP-literal short circuit — no DNS needed.
  const stripped = host.replace(/^\[|\]$/g, "");
  const litFam = isIP(stripped);
  if (litFam !== 0) {
    if (!onAllowList && !(isLoopback && opts.allowLoopback)) {
      const klass = classifyPrivateIp(stripped);
      if (klass) {
        throw new SafeFetchPrivateIpError(host, stripped, klass);
      }
    }
    return {
      url: parsed,
      pinned: { address: stripped, family: litFam === 6 ? 6 : 4 },
    };
  }

  // Loopback name with explicit allow → pin to 127.0.0.1.
  if (isLoopback && (onAllowList || opts.allowLoopback)) {
    return {
      url: parsed,
      pinned: { address: "127.0.0.1", family: 4 },
    };
  }

  const resolver = opts.resolver ?? defaultResolver;
  let addrs: ResolvedAddress[];
  try {
    addrs = await resolver(host);
  } catch (err) {
    throw new SafeFetchDnsError(host, (err as Error).message);
  }
  if (!addrs || addrs.length === 0) {
    throw new SafeFetchDnsError(host, "no records returned");
  }
  if (!onAllowList) {
    for (const a of addrs) {
      const klass = classifyPrivateIp(a.address);
      if (klass) {
        throw new SafeFetchPrivateIpError(host, a.address, klass);
      }
    }
  }
  // Pin to the FIRST address — every call to `safeFetch` re-resolves and
  // re-validates, so a single hostile flip cannot succeed.
  return { url: parsed, pinned: addrs[0] };
}

/**
 * Issue any HTTP request through a pinned-IP undici dispatcher. The single
 * outbound HTTP entry point in METIS — every fetch call site that touches
 * user-supplied URLs MUST route through this helper.
 */
export async function safeFetch(
  url: string | URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dispatcherFactory = options.dispatcherFactory ?? defaultDispatcherFactory;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  let current = await validateTarget(url, options);
  let dispatcher = await dispatcherFactory(current.pinned);
  const dispatchersToClose: DispatcherLike[] = [dispatcher];

  // Forward only the RequestInit fields we want — never let a caller pass a
  // `dispatcher` of their own choosing through this helper.
  const baseInit: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(options)) {
    if (
      k === "redirect" ||
      k === "maxRedirects" ||
      k === "resolver" ||
      k === "dispatcherFactory" ||
      k === "fetchImpl" ||
      k === "allowedHosts" ||
      k === "allowLoopback"
    ) {
      continue;
    }
    baseInit[k] = v;
  }

  const followRedirects = options.redirect === "follow";
  const manualRedirects = options.redirect === "manual";
  let init: Record<string, unknown> = {
    ...baseInit,
    redirect: "manual",
    dispatcher,
  };
  let body = baseInit.body;

  try {
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const res = await fetchImpl(current.url.toString(), init as RequestInit);
      if (res.status < 300 || res.status >= 400) return res;

      const location = res.headers.get("location");
      if (!location) return res; // 3xx without Location — caller handles

      if (manualRedirects) return res; // caller is doing its own redirect dance

      if (!followRedirects) {
        throw new SafeFetchRedirectError(
          current.url.toString(),
          location,
          `safeFetch: redirect to ${location} blocked (redirect:'error')`,
        );
      }
      if (hop === maxRedirects) {
        throw new SafeFetchRedirectError(
          current.url.toString(),
          location,
          `safeFetch: exceeded redirect hop limit (${maxRedirects})`,
        );
      }

      const next = new URL(location, current.url);
      // 303 forces GET with no body; 301/302/307/308 preserve method+body.
      if (res.status === 303) {
        init = { ...init, method: "GET", body: undefined };
        body = undefined;
      } else {
        init = { ...init, body };
      }

      // Re-validate the target host AND rebuild the dispatcher so the
      // pinned IP matches the new origin.
      const validated = await validateTarget(next, options);
      current = validated;
      dispatcher = await dispatcherFactory(validated.pinned);
      dispatchersToClose.push(dispatcher);
      init = { ...init, dispatcher };
    }
    // Unreachable — loop returns or throws.
    throw new SafeFetchRedirectError(
      current.url.toString(),
      current.url.toString(),
      "safeFetch: redirect loop exited without response",
    );
  } finally {
    // Close every dispatcher we built — best effort, swallow errors.
    for (const d of dispatchersToClose) {
      try {
        await d.close?.();
      } catch {
        /* noop */
      }
    }
  }
}

export {
  SafeFetchDnsError,
  SafeFetchPrivateIpError,
  SafeFetchRedirectError,
  SafeFetchSchemeError,
  SafeFetchUrlError,
} from "./safe-fetch.errors.js";
export { isPrivateIp };
