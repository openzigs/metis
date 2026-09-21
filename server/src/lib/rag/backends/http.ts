/**
 * Shared HTTP helper for the remote embeddings backends (Epic #930).
 *
 * Centralizes the retry + error-surfacing policy so the Bedrock-gateway (#932)
 * and OpenAI / Azure (#934) backends behave identically:
 *
 *   - Retry on network errors and 5xx responses with exponential backoff.
 *   - Fail LOUD on 4xx (especially 401/403) — a misconfigured credential must
 *     surface, never silently degrade.
 *   - `fetchImpl` is injectable so tests can mock the transport without a real
 *     network round-trip.
 *   - When no `fetchImpl` is injected, the default transport is proxy-aware so
 *     firewalled clients honour `HTTP(S)_PROXY` / `NO_PROXY` (see proxy-fetch).
 */
import { createProxyFetch } from "./proxy-fetch.js";

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class EmbedBackendHttpError extends Error {
  readonly status: number | undefined;
  readonly backend: string;

  constructor(backend: string, message: string, status?: number) {
    super(message);
    this.name = "EmbedBackendHttpError";
    this.backend = backend;
    this.status = status;
  }
}

export interface FetchJsonOptions {
  backend: string;
  url: string;
  init: RequestInit;
  fetchImpl?: FetchLike;
  maxAttempts?: number;
  /** Base backoff in ms; multiplied by 2^(attempt-1). Tests pass 0. */
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Lazily-built, proxy-aware default transport. Created once on first use so the
 * undici `ProxyAgent` (if any) is reused across requests. Falls back to
 * undefined when the runtime has no global `fetch`.
 */
let defaultFetch: FetchLike | undefined;
function getDefaultFetch(): FetchLike | undefined {
  if (!globalThis.fetch) return undefined;
  defaultFetch ??= createProxyFetch();
  return defaultFetch;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * POST/GET JSON with retry. Returns the parsed JSON body. Throws
 * `EmbedBackendHttpError` on a non-retryable failure or after exhausting
 * attempts.
 */
export async function fetchJsonWithRetry<T>(opts: FetchJsonOptions): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? getDefaultFetch();
  if (!fetchImpl) {
    throw new EmbedBackendHttpError(opts.backend, "global fetch is unavailable in this runtime");
  }
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 3);
  const backoffMs = opts.backoffMs ?? 250;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let res: Response;
    try {
      res = await fetchImpl(opts.url, opts.init);
    } catch (err) {
      lastError = err as Error;
      if (attempt < maxAttempts) {
        await sleep(backoffMs * 2 ** (attempt - 1));
        continue;
      }
      throw new EmbedBackendHttpError(
        opts.backend,
        `network error after ${maxAttempts} attempt(s): ${lastError.message}`,
      );
    }

    if (res.ok) {
      return (await res.json()) as T;
    }

    const bodyText = await safeText(res);
    if (res.status === 401 || res.status === 403) {
      throw new EmbedBackendHttpError(
        opts.backend,
        `authentication failed (${res.status}). Check the API key / credentials. ${truncate(bodyText)}`,
        res.status,
      );
    }
    if (isRetryableStatus(res.status) && attempt < maxAttempts) {
      lastError = new EmbedBackendHttpError(
        opts.backend,
        `upstream ${res.status}: ${truncate(bodyText)}`,
        res.status,
      );
      await sleep(backoffMs * 2 ** (attempt - 1));
      continue;
    }
    throw new EmbedBackendHttpError(
      opts.backend,
      `request failed ${res.status}: ${truncate(bodyText)}`,
      res.status,
    );
  }

  throw new EmbedBackendHttpError(
    opts.backend,
    `request failed after ${maxAttempts} attempt(s): ${lastError?.message ?? "unknown"}`,
  );
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function truncate(s: string, max = 300): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
