/**
 * Epic #195 — diff-apply client.
 *
 * Speaks to the `morph_apply` provider exposed by `metis-copilot-svc`
 * (`POST /apply`) over HTTP. The sidecar wraps the Morph API so the main
 * METIS image stays slim and never sees `MORPH_API_KEY`.
 *
 * Activated when `MORPH_APPLY_ENABLED=true`. Reads:
 *   • `COPILOT_NATIVE_BASE_URL` (default `http://copilot:5060`)
 *   • `COPILOT_NATIVE_TOKEN` — required shared secret
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

export interface DiffApplyClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof undiciRequest;
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
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly request: typeof undiciRequest;

  constructor(opts: DiffApplyClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.COPILOT_NATIVE_BASE_URL ?? "http://copilot:5060";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const token = opts.token ?? process.env.COPILOT_NATIVE_TOKEN ?? "";
    if (!token) {
      throw new Error(
        "COPILOT_NATIVE_TOKEN is required for the diff-apply client — refusing to start without a shared secret.",
      );
    }
    this.token = token;
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
    try {
      const res = await this.request(`${this.baseUrl}/apply`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(input),
        signal: ac.signal,
      });
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const data = (await res.body.json()) as DiffApplyResponse;
        return data;
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
