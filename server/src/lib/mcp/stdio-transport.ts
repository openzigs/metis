/**
 * MCP stdio transport.
 *
 * Spawns a child process with `child_process.spawn` (argv array — NEVER a
 * shell string — so untrusted server configs cannot inject shell metacharacters
 * even if a hostile admin sneaks them through). Frames JSON-RPC messages
 * line-delimited (`\n`) and routes responses by `id`.
 *
 * The PATH for the spawned child is INHERITED from the parent so commands
 * like `npx`, `uvx`, `docker` resolve correctly. We do NOT inherit the rest
 * of the parent's env — secrets like DATABASE_URL, JWT_ACCESS_SECRET, and
 * VAULT_MASTER_KEY MUST NOT leak into a (possibly untrusted) MCP server.
 * Only the keys in `INHERITED_ENV_KEYS` plus the explicitly configured env
 * are forwarded. Callers MUST validate the `command` before calling
 * `start()` (we reject obvious injection attempts here as a safety net but
 * the registry route is the primary boundary).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { Buffer } from "node:buffer";
import { createChildLogger } from "../logger.js";
import type { MCPTransportClient } from "./types.js";

const log = createChildLogger("mcp-stdio");

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const STOP_GRACE_MS = 5_000;
const MAX_PENDING_BUFFER = 1 * 1024 * 1024; // 1 MiB safety cap

/**
 * Whitelist of parent-process env vars forwarded into the child (SEC-4).
 *
 * Rationale per key:
 *   - `PATH`              : `npx`, `uvx`, `docker`, etc. need to resolve binaries.
 *   - `HOME`              : tools that read `~/.config`, npm cache, uvx cache.
 *   - `LANG` / `LC_ALL`   : locale-sensitive output (json escaping, sort order).
 *   - `TZ`                : avoid surprising time conversions.
 *   - `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR` :
 *                            corporate TLS roots — without these MCP servers
 *                            that fetch over HTTPS fail with self-signed errors
 *                            on internal networks.
 *   - `TMPDIR`            : tools writing temp files honour the platform default.
 *   - `DOCKER_HOST` / `DOCKER_API_VERSION` : docker-stdio uses a Docker CLI
 *                            child to spawn sibling wrapper containers; these
 *                            keep socket location and client/daemon API
 *                            negotiation compatible with local Docker Desktop.
 *
 * EVERYTHING ELSE (DATABASE_URL, JWT_ACCESS_SECRET, VAULT_MASTER_KEY,
 * OPENAI_API_KEY, …) is dropped. Adding a key here requires explicit review.
 */
export const INHERITED_ENV_KEYS = Object.freeze([
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_API_VERSION",
] as const);

/**
 * #24 — the environment variable every sidecar carries so `scripts/restart.sh`
 * can find the ones METIS started, and ONLY those, after their parent server is
 * gone. It used to SIGTERM anything whose argv matched `mcp-server-`, which took
 * down other tools' MCP servers on the same machine. restart.sh exports a tag
 * unique to its checkout; a server started some other way marks its sidecars
 * with the bare `metis`, which no restart.sh sweeps (they are still stopped as
 * descendants of the server while it runs). Spread LAST so a configured server
 * env can neither remove nor spoof it. The value identifies a checkout and is
 * not a secret.
 */
function sidecarOwnerEnv(): Record<string, string> {
  return { METIS_SIDECAR_OWNER: process.env.METIS_SIDECAR_OWNER || "metis" };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the child. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Spawn override for tests. */
  spawnFn?: typeof spawn;
}

export class MCPStdioTransport implements MCPTransportClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<
    number | string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private buffer = "";
  private closedDeferred = createDeferred<{ code: number | null; reason: string }>();
  private started = false;
  private stopping = false;

  constructor(private readonly opts: StdioTransportOptions) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    validateCommand(this.opts.command);
    const args = (this.opts.args ?? []).map(String);
    const env = sanitiseEnv(this.opts.env ?? {});

    const spawnFn = this.opts.spawnFn ?? spawn;
    const child = spawnFn(this.opts.command, args, {
      cwd: this.opts.cwd ? resolvePath(this.opts.cwd) : process.cwd(),
      env: { ...inheritedEnv(), ...env, ...sidecarOwnerEnv() },
      // shell: false is the default but make it explicit — we NEVER want a
      // shell interpreting metacharacters in args.
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      log.debug("MCP child stderr", { command: this.opts.command, chunk: chunk.slice(0, 256) });
    });
    child.on("error", (err) => {
      this.failAllPending(new Error(`MCP child error: ${err.message}`));
      this.closedDeferred.resolve({ code: null, reason: `error:${err.message}` });
    });
    child.on("exit", (code, signal) => {
      const reason = signal ? `signal:${signal}` : `exit:${code ?? "null"}`;
      this.failAllPending(new Error(`MCP child exited (${reason})`));
      this.closedDeferred.resolve({ code, reason });
    });
  }

  async stop(reason = "stop"): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.killed || child.exitCode !== null) {
      this.closedDeferred.resolve({ code: child?.exitCode ?? null, reason });
      return;
    }
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignored */
    }
    const closed = await Promise.race([
      this.closedDeferred.promise.then(() => true),
      delay(STOP_GRACE_MS).then(() => false),
    ]);
    if (!closed) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignored */
      }
    }
    this.failAllPending(new Error(`stopped: ${reason}`));
  }

  async request<TResult>(
    method: string,
    params?: unknown,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<TResult> {
    if (!this.child || this.stopping) {
      throw new Error("MCP transport is not running");
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (v) => resolve(v as TResult),
        reject,
        timer,
      });
      try {
        this.child!.stdin.write(`${payload}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.child || this.stopping) {
      throw new Error("MCP transport is not running");
    }
    const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.child.stdin.write(`${payload}\n`);
  }

  async closed(): Promise<{ code: number | null; reason: string }> {
    return this.closedDeferred.promise;
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_PENDING_BUFFER) {
      log.warn("MCP child stdout buffer overflow — discarding", {
        command: this.opts.command,
      });
      this.buffer = "";
      return;
    }
    let idx = this.buffer.indexOf("\n");
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) this.handleMessage(line);
      idx = this.buffer.indexOf("\n");
    }
  }

  private handleMessage(line: string): void {
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line) as JsonRpcResponse;
    } catch {
      log.warn("MCP child sent non-JSON line", { line: line.slice(0, 200) });
      return;
    }
    if (msg.id == null) {
      // Server-initiated notification — log and drop. Future: route to a
      // notification handler when we add elicitation/log forwarding.
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve(msg.result);
    }
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}

/**
 * Reject obviously-dangerous commands. The route layer also validates against
 * the configured allowlist; this is a defence-in-depth check so even a code
 * path that bypasses the route can never spawn `bash -c "rm -rf /"`.
 */
export function validateCommand(command: string): void {
  if (!command || typeof command !== "string") {
    throw new Error("MCP stdio command is required");
  }
  // Refuse shell metacharacters in the command itself. Args may legitimately
  // contain spaces/quotes etc. since they go straight to argv (no shell).
  if (/[;&|`$<>\n\r]/.test(command)) {
    throw new Error("MCP stdio command contains shell metacharacters");
  }
  if (command.length > 512) {
    throw new Error("MCP stdio command is too long");
  }
}

/** Drop env entries with non-string values + cap length — defence against bad input. */
function sanitiseEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof k !== "string" || typeof v !== "string") continue;
    if (k.length === 0 || k.length > 256) continue;
    if (Buffer.byteLength(v, "utf8") > 64 * 1024) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Pull the allow-listed parent env vars (SEC-4). Exported as
 * `INHERITED_ENV_KEYS` for tests + documentation.
 */
export function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of INHERITED_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}
