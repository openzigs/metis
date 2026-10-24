/**
 * Publish Octokit factory — Phase 9 (#66).
 *
 * Builds a cached `@octokit/rest` client — one per (host, owner, pinned
 * address, token) — with:
 *
 *   - `@octokit/plugin-throttling` — primary + secondary rate-limit hooks log
 *     and back off (60s base, exponential, full-jitter, capped at 600s per
 *     R-F2 acceptance criteria).
 *   - `@octokit/plugin-retry`     — 3 retries on 5xx + 429 with exponential
 *     backoff.
 *     (#1471: neither plugin is a dependency or is loaded, so the `throttle`
 *     and `retry` options below are inert; the hooks are unit-tested only.)
 *   - DNS pinning for GHE hosts through our own `fetch` with a pinned undici
 *     dispatcher, so the hostname we resolved is the address we connect to
 *     (TOCTOU defence reused from the connector subsystem), or the corporate
 *     egress proxy when the network requires one; redirects refused and a
 *     per-request deadline (`buildPublishFetch`, #1471).
 *   - `X-GitHub-Api-Version` header (#69 AC).
 *
 * Auth scope is verified on first use against `GET /` (rate-limited cheap
 * endpoint that returns `x-oauth-scopes` for fine-grained tokens) so
 * misconfigured PATs fail fast with a clear error rather than at write time.
 *
 * The token NEVER appears in audit logs or any thrown message.
 */
import { createHash } from "node:crypto";
import {
  DEFAULT_PUBLISH_BACKOFF_BUDGET_MS,
  DEFAULT_PUBLISH_MAX_RETRIES,
  DEFAULT_PUBLISH_RATE_LIMIT_DELAY_MS,
  DEFAULT_PUBLISH_RATE_LIMIT_JITTER_MS,
  DEFAULT_PUBLISH_SECONDARY_BACKOFF_BASE_MS,
  DEFAULT_PUBLISH_SECONDARY_BACKOFF_MAX_MS,
  GITHUB_API_VERSION,
} from "@metis/shared";
import { getConfigService } from "../config/index.js";
import { createChildLogger } from "../logger.js";
import {
  type OctokitFactory,
  type OctokitFactoryArgs,
  type OctokitResponseLike,
  type PublishOctokitLike,
  type PublishRateLimitConfig,
  PublishError,
} from "./types.js";

const log = createChildLogger("publish-octokit");

let octokitFactoryOverride: OctokitFactory | null = null;
export function __setPublishOctokitFactory(factory: OctokitFactory | null): void {
  octokitFactoryOverride = factory;
}

/**
 * Issue #261 — read `PUBLISH_RATE_LIMIT_DELAY_MS` fresh from `ConfigService`
 * on every call so a tunable change in the UI takes effect on the next
 * publish attempt with no restart. Falls back to env then default when the
 * registry is unreachable (e.g. tests that bypass `getConfigService`).
 */
export function currentPublishDelayMs(): number {
  try {
    return getConfigService().getNumber(
      "PUBLISH_RATE_LIMIT_DELAY_MS",
      DEFAULT_PUBLISH_RATE_LIMIT_DELAY_MS,
    );
  } catch {
    return posInt(process.env.PUBLISH_RATE_LIMIT_DELAY_MS, DEFAULT_PUBLISH_RATE_LIMIT_DELAY_MS);
  }
}

/** Issue #261 — fresh per-attempt read of `PUBLISH_MAX_RETRIES`. */
export function currentPublishMaxRetries(): number {
  try {
    return getConfigService().getNumber("PUBLISH_MAX_RETRIES", DEFAULT_PUBLISH_MAX_RETRIES);
  } catch {
    return posInt(process.env.PUBLISH_MAX_RETRIES, DEFAULT_PUBLISH_MAX_RETRIES);
  }
}

/**
 * Default config sourced from environment with safe fallbacks.
 *
 * Issue #261 — `delayMs` and `maxRetries` now read through `ConfigService`
 * so the per-batch snapshot reflects the current DB tunable. The publisher
 * additionally calls `currentPublishDelayMs()` / `currentPublishMaxRetries()`
 * on each attempt so a mid-batch change takes effect immediately, without
 * waiting for the next batch.
 */
export function rateLimitConfigFromEnv(): PublishRateLimitConfig {
  return {
    delayMs: currentPublishDelayMs(),
    jitterMs: posInt(
      process.env.PUBLISH_RATE_LIMIT_JITTER_MS,
      DEFAULT_PUBLISH_RATE_LIMIT_JITTER_MS,
    ),
    secondaryBackoffBaseMs: posInt(
      process.env.PUBLISH_SECONDARY_BACKOFF_BASE_MS,
      DEFAULT_PUBLISH_SECONDARY_BACKOFF_BASE_MS,
    ),
    secondaryBackoffMaxMs: posInt(
      process.env.PUBLISH_SECONDARY_BACKOFF_MAX_MS,
      DEFAULT_PUBLISH_SECONDARY_BACKOFF_MAX_MS,
    ),
    maxRetries: currentPublishMaxRetries(),
    backoffBudgetMs: posInt(
      process.env.PUBLISH_BACKOFF_BUDGET_MS,
      DEFAULT_PUBLISH_BACKOFF_BUDGET_MS,
    ),
  };
}

function posInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

// ---- Per-credential client cache ------------------------------------------

/**
 * #749 — one client per (baseUrl, owner, pinned address, token). The token is
 * part of the key as a full SHA-256, so two credentials publishing to the same
 * owner never share a client: the old "fingerprint" (length + first 2 + last 2
 * characters) collided about 1 in 3,844 for classic `ghp_` PATs, and a publish
 * then went out under another project's token. The pinned address is in the
 * key too, so a client whose agent connects to one resolved IP is never reused
 * for a call that resolved another (#716 DNS pinning).
 *
 * The digest lives in memory only and is NEVER logged. The cache is an LRU
 * bounded at {@link PUBLISH_OCTOKIT_CACHE_MAX} entries, so rotated tokens and
 * many projects cannot grow it without limit.
 */
export const PUBLISH_OCTOKIT_CACHE_MAX = 100;

const clientCache = new Map<string, PublishOctokitLike>();

function cacheKey(opts: AcquirePublishOctokitOptions): string {
  const tokenDigest = createHash("sha256").update(opts.token).digest("hex");
  const pin = opts.pinnedAddress ? `${opts.pinnedAddress}/${opts.pinnedFamily ?? ""}` : "";
  return [opts.baseUrl, opts.owner.toLowerCase(), pin, tokenDigest].join("::");
}

export function __resetPublishOctokitCache(): void {
  clientCache.clear();
}

export interface AcquirePublishOctokitOptions {
  owner: string;
  baseUrl: string;
  token: string;
  pinnedAddress?: string;
  pinnedFamily?: 4 | 6;
  rateLimit?: PublishRateLimitConfig;
  /** Per-request deadline; default {@link PUBLISH_REQUEST_TIMEOUT_MS}. */
  timeoutMs?: number;
}

export async function acquirePublishOctokit(
  opts: AcquirePublishOctokitOptions,
): Promise<PublishOctokitLike> {
  const cfg = opts.rateLimit ?? rateLimitConfigFromEnv();
  const key = cacheKey(opts);
  const existing = clientCache.get(key);
  if (existing) {
    // Re-insert so Map order tracks recency (least recently used first).
    clientCache.delete(key);
    clientCache.set(key, existing);
    return existing;
  }
  const args: OctokitFactoryArgs = {
    baseUrl: opts.baseUrl,
    token: opts.token,
    pinnedAddress: opts.pinnedAddress,
    pinnedFamily: opts.pinnedFamily,
    rateLimit: cfg,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  };
  const client = octokitFactoryOverride
    ? await octokitFactoryOverride(args)
    : await defaultOctokit(args);
  clientCache.set(key, client);
  while (clientCache.size > PUBLISH_OCTOKIT_CACHE_MAX) {
    const oldest = clientCache.keys().next().value;
    if (oldest === undefined) break;
    clientCache.delete(oldest);
  }
  return client;
}

/** #1471 — a GitHub request that has not completed in this long is aborted. */
export const PUBLISH_REQUEST_TIMEOUT_MS = 20_000;

/**
 * #1471 — the `fetch` every publish client sends through.
 *
 * `@octokit/request` ≥10 calls `globalThis.fetch` and reads only `fetch`,
 * `redirect`, `signal` and `log` off `request`: the `agent` (the DNS pin) and
 * `timeout` this factory used to set were silently ignored, so an Enterprise
 * hostname was re-resolved by system DNS (a rebinding window), redirects were
 * followed to any host, and nothing bounded a hung request. Supplying our own
 * `fetch` is the only hook, as `repo-service.ts`'s connector client does:
 *
 *   - the dispatcher is `resolveConnectorDispatcher` — the pinned address, or
 *     the corporate egress proxy when the network requires one — for a pinned
 *     (Enterprise) host, and the egress proxy alone for public github.com;
 *   - `redirect: "error"` — a 3xx is a failure, never followed;
 *   - an `AbortSignal` deadline, combined with any signal the caller passed;
 *   - the `X-GitHub-Api-Version` header (#69), which also used to sit in the
 *     ignored `request` options.
 */
async function buildPublishFetch(args: OctokitFactoryArgs): Promise<typeof fetch> {
  const [{ fetch: undiciFetch }, net] = await Promise.all([
    import("undici"),
    import("../connectors/network-allowlist.js"),
  ]);
  const hostname = new URL(args.baseUrl).hostname;
  let dispatcher: unknown;
  if (args.pinnedAddress) {
    dispatcher = await net.resolveConnectorDispatcher({
      hostname,
      address: args.pinnedAddress,
      family: args.pinnedFamily ?? 4,
    });
  } else {
    const proxyUrl = net.resolveCorporateProxyUrl(hostname);
    if (proxyUrl) {
      const { proxyAgentForBuiltinFetch } = await import("../net/builtin-fetch-dispatcher.js");
      dispatcher = proxyAgentForBuiltinFetch(proxyUrl);
    }
  }
  const timeoutMs = args.timeoutMs ?? PUBLISH_REQUEST_TIMEOUT_MS;
  const publishFetch = (input: string | URL, init: RequestInit = {}) => {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    const headers = new Headers(init.headers);
    if (!headers.has("x-github-api-version")) {
      headers.set("x-github-api-version", GITHUB_API_VERSION);
    }
    return undiciFetch(String(input), {
      ...init,
      headers: Object.fromEntries(headers.entries()),
      redirect: "error",
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    } as Parameters<typeof undiciFetch>[1]);
  };
  return publishFetch as unknown as typeof fetch;
}

async function defaultOctokit(args: OctokitFactoryArgs): Promise<PublishOctokitLike> {
  const { Octokit } = (await import("@octokit/rest")) as unknown as {
    Octokit: new (cfg: unknown) => {
      request: PublishOctokitLike["request"];
    };
  };
  const cfg: Record<string, unknown> = {
    baseUrl: args.baseUrl,
    auth: args.token,
    userAgent: "metis-publisher/1.0",
    request: { fetch: await buildPublishFetch(args), redirect: "error" },
    throttle: buildThrottleHooks(args.rateLimit),
    retry: {
      enabled: true,
      retries: args.rateLimit.maxRetries,
    },
  };
  const inst = new Octokit(cfg);
  return { request: (a) => inst.request(a) };
}

// ---- Throttle hook config (R-F2) ------------------------------------------

interface ThrottleHookOptions {
  request: { method?: string; url?: string };
  retryCount: number;
}

interface OctokitThrottleHooks {
  onRateLimit: (retryAfter: number, options: ThrottleHookOptions) => boolean | Promise<boolean>;
  onSecondaryRateLimit: (
    retryAfter: number,
    options: ThrottleHookOptions,
  ) => boolean | Promise<boolean>;
}

/**
 * Sleep injection seam for the throttle hooks. Tests can override this with
 * `__setThrottleSleep` to fast-forward backoff without changing production
 * timing. F4: production callers MUST actually pause for the computed
 * backoff before the next request — the previous hook only logged.
 */
let throttleSleep: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));
export function __setThrottleSleep(fn: ((ms: number) => Promise<void>) | null): void {
  throttleSleep = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/**
 * Per-process budget tracker — total wall-clock time spent in secondary
 * rate-limit backoff for any single Octokit instance. Once the budget is
 * exhausted the hook stops retrying. Callers can reset between batches via
 * `__resetThrottleBudget` (tests).
 */
const throttleBudgetSpent = new WeakMap<PublishRateLimitConfig, number>();
export function __resetThrottleBudget(cfg: PublishRateLimitConfig): void {
  throttleBudgetSpent.delete(cfg);
}

export function buildThrottleHooks(cfg: PublishRateLimitConfig): OctokitThrottleHooks {
  return {
    onRateLimit: async (retryAfter, options) => {
      log.warn("github primary rate limit", {
        method: options.request.method,
        url: redactUrl(options.request.url),
        retryAfterSec: retryAfter,
        retryCount: options.retryCount,
      });
      if (options.retryCount >= cfg.maxRetries) return false;
      // Honour the server-supplied Retry-After (already in seconds).
      const sleepMs = Math.max(0, retryAfter * 1000);
      await throttleSleep(sleepMs);
      return true;
    },
    onSecondaryRateLimit: async (retryAfter, options) => {
      // R-F2: 60s, doubling per retry, capped at 600s, with full jitter.
      // Honour `retryAfter` from the response header when it's larger than
      // our computed backoff (server knows best).
      const computed = Math.min(
        cfg.secondaryBackoffBaseMs * 2 ** options.retryCount,
        cfg.secondaryBackoffMaxMs,
      );
      const jittered = Math.floor(Math.random() * computed);
      const headerMs = Math.max(0, retryAfter * 1000);
      const sleepMs = Math.max(jittered, headerMs);
      const spent = throttleBudgetSpent.get(cfg) ?? 0;
      if (spent + sleepMs > cfg.backoffBudgetMs) {
        log.error("github secondary rate limit budget exhausted", {
          method: options.request.method,
          url: redactUrl(options.request.url),
          spentMs: spent,
          requestedMs: sleepMs,
          budgetMs: cfg.backoffBudgetMs,
        });
        return false;
      }
      log.warn("github secondary rate limit", {
        method: options.request.method,
        url: redactUrl(options.request.url),
        backoffMs: sleepMs,
        retryCount: options.retryCount,
      });
      // F4: actually pause for the computed delay before signalling the
      // plugin to retry. The plugin will retry IFF we return true.
      await throttleSleep(sleepMs);
      throttleBudgetSpent.set(cfg, spent + sleepMs);
      return options.retryCount < cfg.maxRetries;
    },
  };
}

function redactUrl(url: string | undefined): string {
  if (!url) return "(unknown)";
  // Remove tokens accidentally surfaced in query params.
  return url.replace(/(access_token|client_secret|token)=[^&]+/gi, "$1=[REDACTED]");
}

// ---- Auth scope check ------------------------------------------------------

export async function verifyAuthScope(
  client: PublishOctokitLike,
  expectedRepo: { owner: string; repo: string },
): Promise<{ login: string; canWrite: boolean }> {
  let resp: OctokitResponseLike<{
    permissions?: { push?: boolean; admin?: boolean };
    full_name?: string;
  }>;
  try {
    resp = await client.request({
      method: "GET",
      url: `/repos/${encodeURIComponent(expectedRepo.owner)}/${encodeURIComponent(expectedRepo.repo)}`,
    });
  } catch (err) {
    const e = err as { status?: number };
    if (e.status === 401) {
      throw new PublishError(401, "GITHUB_AUTH_FAILED", "GitHub token rejected");
    }
    if (e.status === 404) {
      throw new PublishError(
        404,
        "GITHUB_REPO_NOT_FOUND",
        `repo ${expectedRepo.owner}/${expectedRepo.repo} not visible to this token`,
      );
    }
    if (e.status === 403) {
      throw new PublishError(
        403,
        "GITHUB_REPO_FORBIDDEN",
        "GitHub token forbidden for this repo (likely missing scope)",
      );
    }
    throw err;
  }
  const perms = resp.data.permissions ?? {};
  const canWrite = Boolean(perms.push || perms.admin);
  if (!canWrite) {
    throw new PublishError(
      403,
      "GITHUB_REPO_NO_WRITE",
      `token cannot write issues to ${expectedRepo.owner}/${expectedRepo.repo}`,
    );
  }
  return { login: resp.data.full_name ?? `${expectedRepo.owner}/${expectedRepo.repo}`, canWrite };
}

/**
 * Inter-mutation jittered delay (R-F2 — ≥1s ± jitter between writes).
 *
 * Issue #261 — `delayMs` is re-read from `ConfigService` on every call so
 * a tunable change mid-batch takes effect immediately, no restart. The
 * jitter window stays constant for the life of the batch (it does not have
 * a registry entry).
 */
export function nextDelayMs(cfg: PublishRateLimitConfig): number {
  const liveDelay = currentPublishDelayMs();
  const jitter = Math.floor((Math.random() * 2 - 1) * cfg.jitterMs);
  return Math.max(0, liveDelay + jitter);
}
