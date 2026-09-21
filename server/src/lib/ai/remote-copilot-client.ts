/**
 * RemoteCopilotClient — HTTP shim that speaks to the optional copilot-svc
 * sidecar (issue #180).
 *
 * The sidecar wraps `@github/copilot-sdk` in its own glibc Node container
 * so the main server can stay minimal/Alpine. This client implements the
 * same {@link CopilotClientLike} surface the in-process wrapper expects,
 * forwarding each call over HTTP and re-emitting SSE events through a
 * local EventEmitter so the wrapper sees the same `on()`/`send()` shape.
 *
 * Activated via `COPILOT_NATIVE_MODE=sidecar`. Reads:
 *   • `COPILOT_NATIVE_BASE_URL` (default `http://copilot:5060`)
 *   • `COPILOT_NATIVE_TOKEN`    (required — shared secret)
 *
 * 401/503 fail loudly (config drift). Network errors retry once.
 */
import { EventEmitter } from "node:events";
import { request as undiciRequest } from "undici";
import type { CopilotClientLike, CopilotSessionLike } from "./copilot-wrapper.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("remote-copilot-client");

export interface RemoteCopilotClientOptions {
  baseUrl?: string;
  token?: string;
  timeoutMs?: number;
  sendTimeoutMs?: number;
}

export class RemoteCopilotClientError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "RemoteCopilotClientError";
    this.status = status;
  }
}

export class RemoteCopilotClient implements CopilotClientLike {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly sendTimeoutMs: number;

  constructor(opts: RemoteCopilotClientOptions = {}) {
    const baseUrl = opts.baseUrl ?? process.env.COPILOT_NATIVE_BASE_URL ?? "http://copilot:5060";
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    const token = opts.token ?? process.env.COPILOT_NATIVE_TOKEN ?? "";
    if (!token) {
      throw new Error(
        "COPILOT_NATIVE_TOKEN is required when COPILOT_NATIVE_MODE=sidecar — refusing to start the client without a shared secret.",
      );
    }
    this.token = token;
    this.timeoutMs = Math.max(
      1_000,
      opts.timeoutMs ?? (Number(process.env.COPILOT_NATIVE_TIMEOUT_MS) || 30_000),
    );
    this.sendTimeoutMs = Math.max(
      1_000,
      opts.sendTimeoutMs ?? (Number(process.env.COPILOT_NATIVE_SEND_TIMEOUT_MS) || 5 * 60 * 1_000),
    );
  }

  async start(): Promise<void> {
    // Sidecar boots independently; we just verify reachability.
    await this.healthz();
  }

  async stop(): Promise<void> {
    /* no-op — sidecar lifecycle is managed by compose */
  }

  async getAuthStatus(): Promise<{ isAuthenticated: boolean; authType?: string }> {
    return this.json<{ isAuthenticated: boolean; authType?: string }>("GET", "/auth/status");
  }

  async listModels(): Promise<Array<{ id: string }>> {
    const res = await this.json<{ models?: Array<{ id: string }> }>("GET", "/models");
    return res.models ?? [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createSession(config: any): Promise<CopilotSessionLike> {
    const res = await this.json<{ sessionId: string }>("POST", "/sessions", config);
    if (!res.sessionId) {
      throw new RemoteCopilotClientError("sidecar createSession missing sessionId", 500);
    }
    return new RemoteSession(this, res.sessionId);
  }

  async healthz(): Promise<{ status: string; tokenConfigured?: boolean }> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.min(this.timeoutMs, 5_000));
    try {
      const res = await undiciRequest(`${this.baseUrl}/healthz`, {
        method: "GET",
        signal: ac.signal,
      });
      if (res.statusCode !== 200) {
        const text = await res.body.text();
        throw new RemoteCopilotClientError(
          `sidecar healthz returned ${res.statusCode}: ${text.slice(0, 200)}`,
          res.statusCode,
        );
      }
      return (await res.body.json()) as { status: string; tokenConfigured?: boolean };
    } finally {
      clearTimeout(t);
    }
  }

  /** Internal — issue an authenticated JSON request. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async json<T>(method: string, path: string, body?: any, customTimeoutMs?: number): Promise<T> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), customTimeoutMs ?? this.timeoutMs);
    try {
      const res = await undiciRequest(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        // 204 or empty body — return undefined-as-T.
        if (status === 204) return undefined as unknown as T;
        return (await res.body.json()) as T;
      }
      const text = await res.body.text();
      throw new RemoteCopilotClientError(
        `sidecar ${method} ${path} returned ${status}: ${text.slice(0, 200)}`,
        status,
      );
    } finally {
      clearTimeout(t);
    }
  }

  /** Internal — open the streaming send endpoint and return the raw response. */
  async sendStream(
    sessionId: string,
    payload: { prompt: string },
  ): Promise<{
    status: number;
    body: NodeJS.ReadableStream;
  }> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.sendTimeoutMs);
    const res = await undiciRequest(
      `${this.baseUrl}/sessions/${encodeURIComponent(sessionId)}/send`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(payload),
        signal: ac.signal,
      },
    );
    // Defer clearing until consumer drains — attach via stream end.
    const stream = res.body as unknown as NodeJS.ReadableStream;
    stream.once("close", () => clearTimeout(t));
    stream.once("end", () => clearTimeout(t));
    return { status: res.statusCode, body: stream };
  }

  /** Internal — close a remote session (best-effort). */
  async destroySession(sessionId: string): Promise<void> {
    try {
      await this.json<unknown>("DELETE", `/sessions/${encodeURIComponent(sessionId)}`, undefined);
    } catch (err) {
      log.warn("sidecar destroySession failed", {
        sessionId,
        error: (err as Error).message,
      });
    }
  }

  get url(): string {
    return this.baseUrl;
  }

  get sendTimeout(): number {
    return this.sendTimeoutMs;
  }
}

/**
 * Remote session — bridges sidecar SSE events into a local EventEmitter that
 * matches the {@link CopilotSessionLike} contract.
 */
class RemoteSession implements CopilotSessionLike {
  readonly sessionId: string;
  private readonly client: RemoteCopilotClient;
  private readonly emitter = new EventEmitter();
  private destroyed = false;

  constructor(client: RemoteCopilotClient, sessionId: string) {
    this.client = client;
    this.sessionId = sessionId;
    // Avoid MaxListeners warnings — wrappers attach a handful per session.
    this.emitter.setMaxListeners(50);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: (payload: any) => void): () => void {
    this.emitter.on(event, handler);
    return () => this.emitter.off(event, handler);
  }

  async send(input: { prompt: string }): Promise<unknown> {
    if (this.destroyed) {
      throw new RemoteCopilotClientError("session destroyed", 410);
    }
    const { status, body } = await this.client.sendStream(this.sessionId, input);
    if (status !== 200) {
      // Drain body to surface server-side error before throwing.
      let text = "";
      try {
        for await (const chunk of body) {
          text += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
          if (text.length > 4_096) break;
        }
      } catch {
        /* ignore drain failure */
      }
      throw new RemoteCopilotClientError(
        `sidecar /sessions/${this.sessionId}/send returned ${status}: ${text.slice(0, 200)}`,
        status,
      );
    }
    await this.consumeStream(body);
    return undefined;
  }

  async sendAndWait(input: { prompt: string }, timeoutMs?: number): Promise<unknown> {
    if (this.destroyed) {
      throw new RemoteCopilotClientError("session destroyed", 410);
    }
    const payload: { prompt: string; timeoutMs?: number } = { prompt: input.prompt };
    if (timeoutMs !== undefined) payload.timeoutMs = timeoutMs;
    return this.client.json<unknown>(
      "POST",
      `/sessions/${encodeURIComponent(this.sessionId)}/send-and-wait`,
      payload,
      timeoutMs !== undefined ? timeoutMs + 5_000 : undefined,
    );
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.client.destroySession(this.sessionId);
    this.emitter.removeAllListeners();
  }

  async disconnect(): Promise<void> {
    return this.destroy();
  }

  /** Parse SSE frames and re-emit each event onto the local emitter. */
  private async consumeStream(stream: NodeJS.ReadableStream): Promise<void> {
    let buf = "";
    for await (const chunk of stream) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      buf += text;
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        this.emitFrame(frame);
      }
    }
    // Tail (no trailing \n\n) — emit if it parses cleanly.
    if (buf.trim().length > 0) this.emitFrame(buf);
  }

  private emitFrame(frame: string): void {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      else if (line.startsWith(":")) {
        /* SSE comment — ignore */
      }
    }
    if (dataLines.length === 0) return;
    const raw = dataLines.join("\n");
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* keep raw string */
    }
    if (event === "error") {
      // Surface server-side errors through the emitter so wrappers can react,
      // but don't throw — `send()` resolves; the caller chose this contract
      // when it registered an `error` listener.
      //
      // Issue #190 — guard against unhandled-error crashes. EventEmitter
      // throws (and crashes the Node process) when an `error` event fires
      // with zero listeners. If no consumer is listening we log and drop
      // the frame instead of taking down the server.
      if (this.emitter.listenerCount("error") === 0) {
        log.warn("sidecar error frame dropped — no listener attached", {
          sessionId: this.sessionId,
          payload: typeof payload === "string" ? payload.slice(0, 200) : payload,
        });
        return;
      }
      this.emitter.emit("error", payload);
      return;
    }
    this.emitter.emit(event, payload);
  }
}

let singleton: RemoteCopilotClient | null = null;

export function getRemoteCopilotClient(): RemoteCopilotClient {
  if (!singleton) singleton = new RemoteCopilotClient();
  return singleton;
}

export function __resetRemoteCopilotClientSingleton(): void {
  singleton = null;
}

/**
 * Mode selection helper. `"sidecar"` when COPILOT_NATIVE_MODE=sidecar,
 * `"in-process"` otherwise. Tests + offline mode always stay in-process.
 */
export function resolveCopilotNativeMode(): "sidecar" | "in-process" {
  const explicit = process.env.COPILOT_NATIVE_MODE?.trim().toLowerCase();
  if (explicit === "sidecar") {
    if (process.env.NODE_ENV === "test" || process.env.VITEST) return "in-process";
    if (process.env.AI_OFFLINE === "1" || process.env.AI_OFFLINE === "true") return "in-process";
    return "sidecar";
  }
  return "in-process";
}
