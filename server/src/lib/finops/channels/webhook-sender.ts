/**
 * Outbound alert webhook sender (Epic #47 / Issue #50).
 *
 * Posts a JSON alert payload to a customer-configured URL, signed with an
 * HMAC-SHA256 signature so the consumer can verify authenticity. Mirrors the
 * inbound GitHub webhook signature convention
 * (`X-Hub-Signature-256: sha256=<hex>` over the raw request body) for the
 * outbound direction.
 *
 * SECURITY (SSRF): outbound URLs are attacker-influenced config. Before any
 * request we:
 *   - reject non-http(s) schemes;
 *   - reject loopback hostnames (localhost, *.localhost) and any host that
 *     resolves to a private / loopback / link-local / ULA / CGNAT IP;
 *   - pin the connection to the resolved public IP (DNS-rebinding defence)
 *     via the `lookup` hook so a TOCTOU re-resolution cannot redirect us to
 *     an internal address;
 *   - never follow redirects (`redirect: "error"`), so a 30x to an internal
 *     URL cannot bypass the check.
 *
 * The signing secret is never logged.
 */
import crypto from "node:crypto";
import dns from "node:dns/promises";
import { isPrivateIp, isLoopbackHostname } from "@metis/shared";
import { createChildLogger } from "../../logger.js";
import { makePinnedLookup } from "../../connectors/network-allowlist.js";

const log = createChildLogger("finops-webhook-sender");

export const SIGNATURE_HEADER = "x-metis-signature-256";
export const TIMESTAMP_HEADER = "x-metis-timestamp";

export interface WebhookSendInput {
  url: string;
  secret: string;
  /** Arbitrary JSON-serialisable payload. */
  payload: unknown;
  /** Override the DNS resolver (tests). */
  resolver?: (host: string) => Promise<string[]>;
  /** Override fetch (tests). */
  fetchFn?: typeof fetch;
  /**
   * Override the pinned-dispatcher factory (tests). Defaults to an undici
   * `Agent` whose `connect.lookup` is pinned to the validated public IP.
   */
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
}

export interface WebhookSendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/** The validated public address to which the outbound socket is pinned. */
export interface PinnedHost {
  /** Original hostname (preserved for Host header / TLS SNI). */
  hostname: string;
  /** Validated public IP literal the socket must connect to. */
  address: string;
  /** IP family of `address`. */
  family: 4 | 6;
}

/** Minimal shape of an undici `Dispatcher` we touch (test seam). */
export interface DispatcherLike {
  close?(): Promise<void>;
  destroy?(err?: Error): Promise<void>;
}

/**
 * Compute the canonical `sha256=<hex>` HMAC signature over a raw body.
 * Exported so a test consumer can independently verify (AC).
 */
export function computeSignature(rawBody: string, secret: string): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Constant-time verification of a signature against a raw body + secret.
 * This is the function a downstream consumer would run; the AC test calls it.
 */
export function verifySignature(
  rawBody: string,
  secret: string,
  signature: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = computeSignature(rawBody, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Parse + scheme-validate a webhook URL. Throws on a disallowed scheme. */
export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("webhook url is not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`webhook protocol ${url.protocol} is not allowed`);
  }
  return url;
}

/**
 * Resolve the host and assert every resolved address is public. Returns the
 * first safe IP so the caller can DNS-pin the connection. Throws on any
 * private/loopback address or an unresolvable host.
 */
export async function assertPublicHost(
  hostname: string,
  resolver: (host: string) => Promise<string[]>,
): Promise<string> {
  if (isLoopbackHostname(hostname)) {
    throw new Error(`webhook host ${hostname} is a loopback name`);
  }
  // A literal IP in the URL is resolved trivially by the OS; classify directly.
  let addresses: string[];
  try {
    addresses = await resolver(hostname);
  } catch {
    throw new Error(`webhook host ${hostname} could not be resolved`);
  }
  if (addresses.length === 0) {
    throw new Error(`webhook host ${hostname} resolved to no addresses`);
  }
  for (const addr of addresses) {
    if (isPrivateIp(addr)) {
      throw new Error(
        `webhook host ${hostname} resolves to a private/loopback address and is not allowed`,
      );
    }
  }
  return addresses[0];
}

async function defaultResolver(host: string): Promise<string[]> {
  // A bare IP literal: short-circuit (lookup of an IP returns it).
  const records = await dns.lookup(host, { all: true });
  return records.map((r) => r.address);
}

/** Detect the IP family of a validated address literal. Exported for tests. */
export function familyOf(address: string): 4 | 6 {
  return address.includes(":") ? 6 : 4;
}

/**
 * Build an undici `Agent` whose connection layer always resolves to the
 * pre-validated public IP. This is the actual DNS-rebinding defence: undici's
 * `fetch` reads the `dispatcher` and the pinned `connect.lookup` forces the
 * socket to the IP we validated, so a low-TTL domain cannot re-resolve to an
 * internal address between `assertPublicHost` and the request (TOCTOU). The
 * original hostname is still used for the Host header + TLS SNI — only the IP
 * the socket connects to is pinned. Dynamically `import('undici')` so this
 * file stays compatible in test environments that mock `fetch`.
 */
export async function makePinnedDispatcher(pinned: PinnedHost): Promise<DispatcherLike> {
  const lookup = makePinnedLookup(pinned.address, pinned.family);
  if (!lookup) {
    // Reaching here would mean an empty address slipped past validation —
    // throw rather than silently fall back to the OS resolver (which would
    // re-open the rebind hole).
    throw new Error("pinned lookup unavailable");
  }
  const undici = (await import("undici")) as unknown as {
    Agent: new (opts: { connect: { lookup: typeof lookup } }) => DispatcherLike;
  };
  return new undici.Agent({ connect: { lookup } });
}

/** Options for {@link pinnedFetch}. */
export interface PinnedFetchOptions {
  /** Target URL (scheme-validated, host-resolved + public-asserted internally). */
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** Pre-serialised request body. */
  body?: string;
  /** Override the DNS resolver (tests). */
  resolver?: (host: string) => Promise<string[]>;
  /** Override fetch (tests). */
  fetchFn?: typeof fetch;
  /** Override the pinned-dispatcher factory (tests). */
  dispatcherFactory?: (pinned: PinnedHost) => Promise<DispatcherLike>;
  /** Request timeout in ms (default 10s). */
  timeoutMs?: number;
}

/**
 * SSRF-hardened outbound fetch — the SINGLE send-time egress primitive shared by
 * every attacker-influenced webhook surface (FinOps alert sender + Epic #165
 * hook dispatch). It:
 *   - scheme-validates the URL (http/https only);
 *   - resolves the host and asserts EVERY address is public at SEND time (so a
 *     config-time-valid host that has since been repointed to a private /
 *     metadata address — DNS rebinding / TOCTOU — is rejected here, not just at
 *     config time);
 *   - pins the socket to the validated public IP so a low-TTL domain cannot
 *     re-resolve to an internal address between validation and connect;
 *   - sets `redirect: "error"` so a 30x to an internal URL is never followed.
 *
 * Throws on a disallowed scheme/host, an unresolvable host, or a fetch/redirect
 * error. Callers decide how to surface failure (return code vs. best-effort).
 */
export async function pinnedFetch(opts: PinnedFetchOptions): Promise<Response> {
  const resolver = opts.resolver ?? defaultResolver;
  const doFetch = opts.fetchFn ?? fetch;
  const dispatcherFactory = opts.dispatcherFactory ?? makePinnedDispatcher;
  const timeoutMs = opts.timeoutMs ?? 10_000;

  const url = parseWebhookUrl(opts.url);
  const address = await assertPublicHost(url.hostname, resolver);
  const pinned: PinnedHost = { hostname: url.hostname, address, family: familyOf(address) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let dispatcher: DispatcherLike | undefined;
  try {
    // Pin the socket to the validated IP. The fetch still targets the original
    // URL (hostname preserved for Host/SNI); only the connect lookup is forced.
    dispatcher = await dispatcherFactory(pinned);
    // `dispatcher` is an undici-only extension to RequestInit; build a plain
    // record and cast (mirrors scheduler/webhook-handler.ts).
    const init: Record<string, unknown> = {
      method: opts.method ?? "POST",
      headers: opts.headers,
      body: opts.body,
      redirect: "error",
      signal: controller.signal,
      // undici reads `dispatcher` to route the connection through the
      // pinned-lookup Agent (DNS-rebinding defence).
      dispatcher,
    };
    return await doFetch(url.toString(), init as RequestInit);
  } finally {
    clearTimeout(timer);
    // Release the pooled socket so a pinned dispatcher does not linger.
    try {
      await dispatcher?.close?.();
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Send a signed alert webhook with full SSRF protection.
 */
export async function sendWebhook(input: WebhookSendInput): Promise<WebhookSendResult> {
  let hostForLog: string;
  try {
    hostForLog = parseWebhookUrl(input.url).hostname;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const rawBody = JSON.stringify(input.payload);
  const signature = computeSignature(rawBody, input.secret);
  const timestamp = new Date().toISOString();

  try {
    const res = await pinnedFetch({
      url: input.url,
      method: "POST",
      headers: {
        "content-type": "application/json",
        [SIGNATURE_HEADER]: signature,
        [TIMESTAMP_HEADER]: timestamp,
        "user-agent": "metis-finops-alerts/1",
      },
      body: rawBody,
      resolver: input.resolver,
      fetchFn: input.fetchFn,
      dispatcherFactory: input.dispatcherFactory,
      timeoutMs: input.timeoutMs,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    // Do NOT log the secret or signature — only the URL host + error.
    log.warn("webhook delivery failed", {
      host: hostForLog,
      error: (err as Error).message,
    });
    return { ok: false, error: (err as Error).message };
  }
}
