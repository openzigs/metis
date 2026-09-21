/**
 * URL fetcher with SSRF protection — Phase 5 follow-up (issue #132).
 *
 * Hardening:
 *   - Only `http:` and `https:` schemes accepted.
 *   - DNS resolution happens BEFORE the request — every resolved IP must be
 *     publicly routable. Loopback, link-local, RFC1918 private CIDRs,
 *     `0.0.0.0/8`, broadcast, multicast, IPv4-mapped IPv6 private, and the
 *     IPv6 unique-local / link-local ranges are all rejected.
 *   - Optional regex allow-list via `INGEST_URL_ALLOWLIST` env. When set, the
 *     hostname must match at least one entry. When unset the fetcher still
 *     refuses private IPs but no explicit hostname allow-list is enforced.
 *   - Hard size cap of `MAX_DOCUMENT_BYTES` — both via Content-Length and a
 *     streaming counter.
 *   - Hard time cap (`INGEST_URL_TIMEOUT_MS`, default 15 s) via AbortController.
 *   - No redirects to private IPs — `manual` redirect mode + per-hop revalidation.
 */
import dns from "node:dns/promises";
import net from "node:net";
import { MAX_DOCUMENT_BYTES, UPLOAD_MIME_ALLOWLIST, isPrivateIp } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import {
  safeFetch,
  type ResolvedAddress,
  type SafeFetchOptions,
  type SafeFetchResolver,
} from "../net/safe-fetch.js";
import {
  SafeFetchDnsError,
  SafeFetchPrivateIpError,
  SafeFetchRedirectError,
  SafeFetchSchemeError,
  SafeFetchUrlError,
} from "../net/safe-fetch.errors.js";

const log = createChildLogger("url-fetch");

// Re-export so existing callers that import `isPrivateIp` from this module
// keep working post-#299 (e.g. `server/src/lib/tools/browser/browser-verify.ts`).
export { isPrivateIp };

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

/**
 * A fetch rejection with the reason spelled out.
 *
 * SECURITY (#1084): the `PRIVATE_HOST_BLOCKED` / `DNS_FAILURE` messages built
 * below deliberately name the resolved address, its non-routable range, and
 * the hostname — operators need that to debug a block. It is therefore
 * **log-only**: any route serving a caller-supplied URL MUST pass this through
 * `collapseUrlFetchRejection` (`./url-fetch-rejection.ts`) instead of
 * forwarding `err.message`, `err.code`, or `err.status` to the client.
 */
export class UrlFetchError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "UrlFetchError";
    this.status = status;
    this.code = code;
  }
}

export interface FetchedDocument {
  buffer: Buffer;
  contentType: string;
  finalUrl: string;
  filename: string;
}

export interface UrlFetcherOptions {
  /** Overrides `INGEST_URL_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Overrides `MAX_DOCUMENT_BYTES`. */
  maxBytes?: number;
  /** Overrides `INGEST_URL_ALLOWLIST` env. */
  allowlistRegex?: RegExp[] | null;
  /** Overrides DNS lookup (test injection). */
  resolver?: (host: string) => Promise<string[]>;
  /** Override fetch (test injection). */
  fetchImpl?: typeof fetch;
}

/**
 * Validate + fetch a URL for ingestion. Throws `UrlFetchError` on any
 * SSRF, timeout, size, or content-type issue. The caller is responsible
 * for the parse → chunk → embed pipeline.
 */
export async function fetchUrlForIngest(
  rawUrl: string,
  opts: UrlFetcherOptions = {},
): Promise<FetchedDocument> {
  const maxBytes = opts.maxBytes ?? MAX_DOCUMENT_BYTES;
  const timeoutMs =
    opts.timeoutMs ?? parsePositiveInt(process.env.INGEST_URL_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const allowlist = opts.allowlistRegex ?? loadAllowlist();
  const resolver = opts.resolver ?? defaultResolver;

  let currentUrl = parseUrl(rawUrl);
  let hops = 0;
  let response: Response | null = null;
  let lastFinalUrl = currentUrl.toString();

  while (hops <= MAX_REDIRECTS) {
    assertHostnameAllowed(currentUrl.hostname, allowlist);
    // Defence in depth: an explicit pre-flight DNS check so the structured
    // `UrlFetchError("PRIVATE_HOST_BLOCKED")` is still surfaced to callers
    // even though `safeFetch` would also reject the same target. Tests
    // continue to mock `resolver` here.
    await assertResolvesToPublic(currentUrl.hostname, resolver);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      // Issue #303 — route through the canonical safeFetch so the IP
      // validated by `assertResolvesToPublic` above is also pinned into
      // the undici dispatcher. This closes the DNS-rebinding TOCTOU
      // window that existed when this function called `fetch` directly.
      const safeResolver: SafeFetchResolver = async (host): Promise<ResolvedAddress[]> => {
        const addrs = await resolver(host);
        return addrs.map((address) => ({
          address,
          family: (net.isIP(address) === 6 ? 6 : 4) as 4 | 6,
        }));
      };
      const safeOpts: SafeFetchOptions = {
        method: "GET",
        signal: ac.signal,
        headers: { "user-agent": "metis-ingest/1.0", accept: "*/*" },
        resolver: safeResolver,
        // Caller does its own per-hop validation through `assertResolvesToPublic`.
        redirect: "manual",
      };
      // Honour the test injection: when the caller passed a `fetchImpl`
      // we forward it so unit tests can mock the transport without
      // building a real undici dispatcher.
      if (opts.fetchImpl) {
        safeOpts.fetchImpl = opts.fetchImpl;
        // No-op dispatcher when tests override fetch — undici is not in play.
        safeOpts.dispatcherFactory = async () => ({ close: async () => undefined });
      }
      response = await safeFetch(currentUrl, safeOpts);
    } catch (err) {
      const e = err as Error & { name?: string };
      if (e.name === "AbortError") {
        throw new UrlFetchError(504, "FETCH_TIMEOUT", `URL fetch timed out after ${timeoutMs} ms`);
      }
      if (err instanceof SafeFetchPrivateIpError) {
        throw new UrlFetchError(
          403,
          "PRIVATE_HOST_BLOCKED",
          `Host resolves to ${err.address} which is in non-routable range (${err.classification})`,
        );
      }
      if (err instanceof SafeFetchDnsError) {
        throw new UrlFetchError(502, "DNS_FAILURE", e.message);
      }
      if (err instanceof SafeFetchSchemeError) {
        throw new UrlFetchError(400, "UNSUPPORTED_SCHEME", e.message);
      }
      if (err instanceof SafeFetchUrlError) {
        throw new UrlFetchError(400, "INVALID_URL", e.message);
      }
      if (err instanceof SafeFetchRedirectError) {
        // The redirect handler below also reports REDIRECT_NO_LOCATION /
        // TOO_MANY_REDIRECTS for the legacy code paths. A SafeFetchRedirect
        // error means the canonical helper itself refused — surface it as
        // a generic 502.
        throw new UrlFetchError(502, "FETCH_FAILED", e.message);
      }
      throw new UrlFetchError(502, "FETCH_FAILED", `URL fetch failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
    lastFinalUrl = currentUrl.toString();
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get("location");
      if (!loc) {
        throw new UrlFetchError(
          502,
          "REDIRECT_NO_LOCATION",
          "Redirect response missing Location header",
        );
      }
      const next = new URL(loc, currentUrl);
      currentUrl = parseUrl(next.toString());
      hops += 1;
      continue;
    }
    break;
  }
  if (!response) throw new UrlFetchError(502, "FETCH_FAILED", "No response received");
  if (hops > MAX_REDIRECTS) {
    throw new UrlFetchError(502, "TOO_MANY_REDIRECTS", `More than ${MAX_REDIRECTS} redirects`);
  }
  if (response.status < 200 || response.status >= 300) {
    throw new UrlFetchError(
      response.status === 404 ? 404 : 502,
      "FETCH_BAD_STATUS",
      `Upstream responded ${response.status} ${response.statusText}`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new UrlFetchError(
      413,
      "RESPONSE_TOO_LARGE",
      `Content-Length ${declaredLength} exceeds limit ${maxBytes}`,
    );
  }

  const contentType = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType.length === 0) {
    throw new UrlFetchError(415, "MISSING_CONTENT_TYPE", "Upstream did not declare a content-type");
  }
  if (!(UPLOAD_MIME_ALLOWLIST as readonly string[]).includes(contentType)) {
    throw new UrlFetchError(
      415,
      "MIME_NOT_ALLOWED",
      `Upstream content-type '${contentType}' is not in the allowlist`,
    );
  }

  const buffer = await readBodyCapped(response, maxBytes);
  const filename = filenameFromUrl(lastFinalUrl, contentType);
  log.debug("URL ingest fetched", {
    url: lastFinalUrl,
    bytes: buffer.length,
    contentType,
  });
  return { buffer, contentType, finalUrl: lastFinalUrl, filename };
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const ab = await response.arrayBuffer();
    if (ab.byteLength > maxBytes) {
      throw new UrlFetchError(
        413,
        "RESPONSE_TOO_LARGE",
        `Body ${ab.byteLength} exceeds ${maxBytes}`,
      );
    }
    return Buffer.from(ab);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* swallow */
      }
      throw new UrlFetchError(413, "RESPONSE_TOO_LARGE", `Body ${total} exceeds ${maxBytes}`);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((c) => Buffer.from(c)),
    total,
  );
}

export function parseUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UrlFetchError(400, "INVALID_URL", `Not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new UrlFetchError(
      400,
      "UNSUPPORTED_SCHEME",
      `Only http/https are supported, got ${parsed.protocol}`,
    );
  }
  if (parsed.username || parsed.password) {
    throw new UrlFetchError(400, "URL_HAS_CREDENTIALS", "URL must not contain credentials");
  }
  if (!parsed.hostname) {
    throw new UrlFetchError(400, "INVALID_URL", "URL is missing a hostname");
  }
  return parsed;
}

function loadAllowlist(): RegExp[] | null {
  const raw = process.env.INGEST_URL_ALLOWLIST;
  if (!raw || raw.trim().length === 0) return null;
  const out: RegExp[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(new RegExp(trimmed, "i"));
    } catch (err) {
      log.warn("INGEST_URL_ALLOWLIST entry is not a valid regex; skipping", {
        entry: trimmed,
        error: (err as Error).message,
      });
    }
  }
  return out.length > 0 ? out : null;
}

export function assertHostnameAllowed(host: string, allowlist: RegExp[] | null): void {
  if (!allowlist) return;
  const hit = allowlist.some((rx) => rx.test(host));
  if (!hit) {
    throw new UrlFetchError(
      403,
      "HOST_NOT_ALLOWED",
      `Hostname '${host}' is not in INGEST_URL_ALLOWLIST`,
    );
  }
}

export async function assertResolvesToPublic(
  host: string,
  resolver: (host: string) => Promise<string[]>,
): Promise<void> {
  // Reject hostnames that are themselves IP literals in private ranges before
  // we even hit DNS.
  const literalKind = net.isIP(host);
  if (literalKind > 0) {
    if (isPrivateIp(host)) {
      throw new UrlFetchError(
        403,
        "PRIVATE_HOST_BLOCKED",
        `Hostname literal '${host}' resolves to a private/loopback range`,
      );
    }
    return;
  }
  let resolved: string[];
  try {
    resolved = await resolver(host);
  } catch (err) {
    throw new UrlFetchError(
      502,
      "DNS_FAILURE",
      `DNS lookup failed for ${host}: ${(err as Error).message}`,
    );
  }
  if (resolved.length === 0) {
    throw new UrlFetchError(502, "DNS_FAILURE", `DNS lookup returned no records for ${host}`);
  }
  for (const ip of resolved) {
    if (isPrivateIp(ip)) {
      throw new UrlFetchError(
        403,
        "PRIVATE_HOST_BLOCKED",
        `Hostname '${host}' resolves to private/loopback IP ${ip}`,
      );
    }
  }
}

async function defaultResolver(host: string): Promise<string[]> {
  const records = await dns.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
}

// `isPrivateIp`, `isPrivateIPv4`, and `isPrivateIPv6` were moved to
// `packages/shared/src/net/private-ip.ts` in #299. This file re-exports
// `isPrivateIp` (above) for backwards compatibility with callers like
// `server/src/lib/tools/browser/browser-verify.ts`.

function filenameFromUrl(url: string, contentType: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "url-ingest";
  }
  const last = parsed.pathname.split("/").filter(Boolean).pop();
  const ext = extensionForContentType(contentType);
  if (last && last.length > 0) {
    if (/\.[a-z0-9]+$/i.test(last)) return last.slice(0, 200);
    return ext ? `${last}.${ext}`.slice(0, 200) : last.slice(0, 200);
  }
  // No path component — use the hostname as a stable filename root and
  // always append the inferred extension (the hostname may itself contain
  // dots, but those are not file extensions).
  const hostBase = parsed.hostname.replace(/[^a-z0-9.-]+/gi, "_");
  return ext ? `${hostBase}.${ext}`.slice(0, 200) : hostBase.slice(0, 200);
}

function extensionForContentType(ct: string): string | null {
  switch (ct) {
    case "text/plain":
      return "txt";
    case "text/markdown":
    case "text/x-markdown":
      return "md";
    case "text/html":
      return "html";
    case "application/json":
      return "json";
    case "application/pdf":
      return "pdf";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return "docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return "xlsx";
    default:
      return null;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
