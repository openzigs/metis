/**
 * Epic #192 (A.1) — sandbox client.
 *
 * Speaks to the {@link https://github.com/openzigs/metis copilot-svc}
 * `POST /sandbox/exec` endpoint over HTTP using `undici`. The E2B SDK lives
 * exclusively in the sidecar so the slim METIS image never imports it
 * (Epic A acceptance criterion: `≤350 MB`).
 *
 * Activated when `SANDBOX_MODE=sidecar`. Reads:
 *   - `COPILOT_NATIVE_BASE_URL` (default `http://copilot:5060`)
 *   - `COPILOT_NATIVE_TOKEN` — required shared secret
 *   - `SANDBOX_TIMEOUT_MS` — default 30s (override via per-call `timeoutMs`)
 *
 * Network/timeout/sandbox errors map to typed {@link SandboxClientError}
 * instances so callers can decide whether to retry, fail, or bypass.
 */
import { request as undiciRequest } from "undici";

export type SandboxLanguage = "python" | "node" | "bash";

export interface SandboxExecRequest {
  language: SandboxLanguage;
  code: string;
  timeoutMs?: number;
}

export interface SandboxExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface SandboxClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  fetchImpl?: typeof undiciRequest;
}

export class SandboxClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "SANDBOX_ERROR") {
    super(message);
    this.name = "SandboxClientError";
    this.status = status;
    this.code = code;
  }
}

export function isSandboxSidecarMode(): boolean {
  const raw = process.env.SANDBOX_MODE;
  if (!raw) return false;
  return raw.trim().toLowerCase() === "sidecar";
}

export class SandboxClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly request: typeof undiciRequest;

  constructor(opts: SandboxClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.COPILOT_NATIVE_BASE_URL ?? "http://copilot:5060";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const token = opts.token ?? process.env.COPILOT_NATIVE_TOKEN ?? "";
    if (!token) {
      throw new Error(
        "COPILOT_NATIVE_TOKEN is required for the sandbox client — refusing to start without a shared secret.",
      );
    }
    this.token = token;
    this.timeoutMs = Math.max(
      1_000,
      opts.timeoutMs ?? (Number(process.env.SANDBOX_TIMEOUT_MS) || 30_000),
    );
    this.request = opts.fetchImpl ?? undiciRequest;
  }

  async exec(input: SandboxExecRequest): Promise<SandboxExecResponse> {
    if (!input.code || typeof input.code !== "string") {
      throw new SandboxClientError("exec: `code` is required", 400, "BAD_REQUEST");
    }
    if (!["python", "node", "bash"].includes(input.language)) {
      throw new SandboxClientError("exec: `language` must be python|node|bash", 400, "BAD_REQUEST");
    }
    const ac = new AbortController();
    // Add a small grace period over the upstream timeout so we don't race
    // with the sidecar's own deadline.
    const timer = setTimeout(() => ac.abort(), this.timeoutMs + 5_000);
    try {
      const res = await this.request(`${this.baseUrl}/sandbox/exec`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({
          language: input.language,
          code: input.code,
          timeoutMs: input.timeoutMs ?? this.timeoutMs,
        }),
        signal: ac.signal,
      });
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        const data = (await res.body.json()) as SandboxExecResponse;
        return data;
      }
      const text = await res.body.text();
      const code =
        status === 503
          ? "SANDBOX_UNAVAILABLE"
          : status === 504
            ? "SANDBOX_TIMEOUT"
            : status === 401
              ? "UNAUTHORIZED"
              : "SANDBOX_ERROR";
      throw new SandboxClientError(`sandbox exec ${status}: ${text.slice(0, 200)}`, status, code);
    } catch (err) {
      if (err instanceof SandboxClientError) throw err;
      const e = err as { name?: string; message?: string };
      if (e.name === "AbortError") {
        throw new SandboxClientError(
          `sandbox exec timed out after ${this.timeoutMs}ms`,
          504,
          "SANDBOX_TIMEOUT",
        );
      }
      throw new SandboxClientError(
        `sandbox exec failed: ${e.message ?? "unknown"}`,
        502,
        "SANDBOX_NETWORK",
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
