/**
 * Epic #195 — diff-apply client.
 *
 * Calls the Morph apply API (`MORPH_API_URL`, default
 * `https://api.morphllm.com/v1/apply`) directly. #150 — this used to go through
 * the `copilot-svc` sidecar's `POST /apply`; the sidecar existed for the GitHub
 * Copilot SDK and was removed with it, so the Morph call moved in-process with
 * the same request shape, auth header and response mapping.
 *
 * Activated when `MORPH_APPLY_ENABLED=true`. Reads:
 *   • `MORPH_API_KEY` — required; the client refuses to construct without it
 *   • `MORPH_API_URL` — default `https://api.morphllm.com/v1/apply`
 *   • `MORPH_MODEL` — default `morph-v3`
 *   • `MORPH_APPLY_TIMEOUT_MS` — default 30s
 *
 * Network/timeout errors are mapped to {@link DiffApplyClientError} with the
 * upstream status preserved so the caller can decide whether to fall back to
 * a whole-file rewrite. `apply_diff` (server/src/lib/ai/tools/apply-diff.ts)
 * is the only registered consumer.
 */
import { request as undiciRequest } from "undici";

export interface DiffApplyRequest {
  /** Original file contents. Required so Morph can locate the diff context. */
  original: string;
  /** Unified diff or instruction string emitted by the LLM. */
  patch: string;
  /** Optional file path for telemetry/logging only. */
  path?: string;
  /** Override the model id Morph routes to. Server resolves the default. */
  model?: string;
}

export interface DiffApplyResponse {
  /** Result of applying the patch. */
  content: string;
  /** Provider tag (always "morph" for this client). */
  provider: "morph";
  model: string;
  /** Raw token accounting from the upstream Morph API. */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Wall-clock duration of the upstream call. */
  durationMs: number;
}

export const DEFAULT_MORPH_API_URL = "https://api.morphllm.com/v1/apply";
export const DEFAULT_MORPH_MODEL = "morph-v3";

export interface DiffApplyClientOptions {
  /** Full Morph apply endpoint URL (default `MORPH_API_URL` / the public API). */
  apiUrl?: string;
  /** Morph API key (default `MORPH_API_KEY`). */
  apiKey?: string;
  /** Default model when the request names none (default `MORPH_MODEL`). */
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof undiciRequest;
}

/** The Morph apply API's response body (either content field name is accepted). */
interface MorphApiResponse {
  content?: string;
  result?: string;
  model?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export class DiffApplyClientError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DiffApplyClientError";
    this.status = status;
  }
}

export class DiffApplyClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly request: typeof undiciRequest;

  constructor(opts: DiffApplyClientOptions = {}) {
    this.apiUrl = opts.apiUrl ?? (process.env.MORPH_API_URL?.trim() || DEFAULT_MORPH_API_URL);
    const apiKey = (opts.apiKey ?? process.env.MORPH_API_KEY ?? "").trim();
    if (!apiKey) {
      throw new Error(
        "MORPH_API_KEY is required for the diff-apply client — refusing to start without it.",
      );
    }
    this.apiKey = apiKey;
    this.model = opts.model ?? (process.env.MORPH_MODEL?.trim() || DEFAULT_MORPH_MODEL);
    this.timeoutMs = Math.max(
      1_000,
      opts.timeoutMs ?? (Number(process.env.MORPH_APPLY_TIMEOUT_MS) || 30_000),
    );
    this.request = opts.fetchImpl ?? undiciRequest;
  }

  async apply(input: DiffApplyRequest): Promise<DiffApplyResponse> {
    if (!input.original || typeof input.original !== "string") {
      throw new DiffApplyClientError("apply: `original` is required", 400);
    }
    if (!input.patch || typeof input.patch !== "string") {
      throw new DiffApplyClientError("apply: `patch` is required", 400);
    }
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    const start = Date.now();
    const model = input.model ?? this.model;
    try {
      const res = await this.request(this.apiUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          model,
          original: input.original,
          patch: input.patch,
          path: input.path,
        }),
        signal: ac.signal,
      });
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const body = (await res.body.json()) as MorphApiResponse;
        const usage = body.usage ?? {};
        const promptTokens = usage.promptTokens ?? 0;
        const completionTokens = usage.completionTokens ?? 0;
        return {
          content: body.content ?? body.result ?? "",
          provider: "morph",
          model: body.model ?? model,
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: usage.totalTokens ?? promptTokens + completionTokens,
          },
          durationMs: Date.now() - start,
        };
      }
      const text = await res.body.text();
      throw new DiffApplyClientError(`morph apply ${status}: ${text.slice(0, 200)}`, status);
    } catch (err) {
      if (err instanceof DiffApplyClientError) throw err;
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        throw new DiffApplyClientError(`morph apply timed out after ${this.timeoutMs}ms`, 504);
      }
      throw new DiffApplyClientError(`morph apply failed: ${e.message ?? "unknown"}`, 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

export function isMorphApplyEnabled(): boolean {
  const raw = process.env.MORPH_APPLY_ENABLED;
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
