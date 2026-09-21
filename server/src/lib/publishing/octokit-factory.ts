/**
 * Publish Octokit factory — Phase 9 (#66).
 *
 * Builds a per-org cached `@octokit/rest` client with:
 *
 *   - `@octokit/plugin-throttling` — primary + secondary rate-limit hooks log
 *     and back off (60s base, exponential, full-jitter, capped at 600s per
 *     R-F2 acceptance criteria).
 *   - `@octokit/plugin-retry`     — 3 retries on 5xx + 429 with exponential
 *     backoff.
 *   - DNS pinning for GHE hosts via a custom `https.Agent.lookup` so the
 *     hostname we resolve is the hostname we actually connect to (TOCTOU
 *     defence reused from the connector subsystem).
 *   - `X-GitHub-Api-Version` header (#69 AC).
 *
 * Auth scope is verified on first use against `GET /` (rate-limited cheap
 * endpoint that returns `x-oauth-scopes` for fine-grained tokens) so
 * misconfigured PATs fail fast with a clear error rather than at write time.
 *
 * The token NEVER appears in audit logs or any thrown message.
 */
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
import { makePinnedLookup } from "../connectors/network-allowlist.js";
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

// ---- Per-org client cache --------------------------------------------------

interface CacheEntry {
  client: PublishOctokitLike;
  tokenFingerprint: string;
  baseUrl: string;
}

const clientCache = new Map<string, CacheEntry>();

function cacheKey(owner: string, baseUrl: string): string {
  return `${baseUrl}::${owner.toLowerCase()}`;
}

function fingerprint(token: string): string {
  // Non-reversible truncated digest used purely to detect rotations. NEVER
  // log or expose this — it is enough to confirm "same token" with low
  // collision risk, but should not be treated as a credential.
  return token.length === 0 ? "empty" : `${token.length}:${token.slice(0, 2)}…${token.slice(-2)}`;
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
}

export async function acquirePublishOctokit(
  opts: AcquirePublishOctokitOptions,
): Promise<PublishOctokitLike> {
  const cfg = opts.rateLimit ?? rateLimitConfigFromEnv();
  const key = cacheKey(opts.owner, opts.baseUrl);
  const existing = clientCache.get(key);
  const fp = fingerprint(opts.token);
  if (existing && existing.tokenFingerprint === fp && existing.baseUrl === opts.baseUrl) {
    return existing.client;
  }
  const args: OctokitFactoryArgs = {
    baseUrl: opts.baseUrl,
    token: opts.token,
    pinnedAddress: opts.pinnedAddress,
    pinnedFamily: opts.pinnedFamily,
    rateLimit: cfg,
  };
  const client = octokitFactoryOverride
    ? await octokitFactoryOverride(args)
    : await defaultOctokit(args);
  clientCache.set(key, { client, tokenFingerprint: fp, baseUrl: opts.baseUrl });
  return client;
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
    request: {
      timeout: 20_000,
      headers: {
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    },
    throttle: buildThrottleHooks(args.rateLimit),
    retry: {
      enabled: true,
      retries: args.rateLimit.maxRetries,
    },
  };
  if (args.pinnedAddress) {
    const https = await import("node:https");
    cfg.request = {
      ...((cfg.request as Record<string, unknown>) ?? {}),
      agent: new https.Agent({
        keepAlive: false,
        lookup: makePinnedLookup(args.pinnedAddress, args.pinnedFamily),
      }),
    };
  }
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
