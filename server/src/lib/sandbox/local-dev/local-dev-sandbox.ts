/**
 * Local-dev sandbox (Epic #395 #417).
 *
 * Wraps every shell command in `bwrap` (Linux) or `sandbox-exec`
 * (macOS) so engineers can run the agent test loop on a developer
 * laptop without burning E2B / Daytona credits. NOT multi-tenant
 * isolation — the host kernel is shared (research §2.4).
 *
 * Inherits the noop kernel semantics for `runCode` (the in-process
 * arithmetic mini-kernel) since `bwrap`/`sandbox-exec` only protect
 * shell exec — code execution is symbolic.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { ulid } from "ulid";

import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { SANDBOX_HARD_LIMITS } from "../limits.js";
import { calculateSandboxCost } from "../pricing/calculator.js";
import { buildSandboxEnv } from "../noop/noop-sandbox.js";
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
import { buildBwrapArgv } from "./profiles/linux-bwrap.js";

export type LocalDevHostOs = "linux" | "darwin";

export interface LocalDevSandboxDeps {
  sessionId: string;
  vendorSandboxId: string;
  projectId: string;
  userId: string | null;
  rootDir: string;
  timeoutMs: number;
  vCpus: number;
  memMiB: number;
  hostOs: LocalDevHostOs;
  /** Absolute path to the macOS `.sb` profile (required when hostOs='darwin'). */
  macosProfilePath?: string;
  emitter: SandboxAuditEmitter;
  sessionRepo: SandboxSessionRepo;
  now?: () => number;
}

export class LocalDevSandbox implements Sandbox {
  readonly id: string;
  readonly vendorSandboxId: string;
  readonly provider: SandboxProviderKind = "local_dev";

  private readonly rootDir: string;
  private readonly projectId: string;
  private readonly userId: string | null;
  private readonly timeoutMs: number;
  private readonly vCpus: number;
  private readonly memMiB: number;
  private readonly hostOs: LocalDevHostOs;
  private readonly macosProfilePath: string | undefined;
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly createdAtMs: number;
  private readonly createdAt: Date;
  private readonly now: () => number;
  private destroyed = false;
  private timedOut = false;

  constructor(deps: LocalDevSandboxDeps) {
    this.id = deps.sessionId;
    this.vendorSandboxId = deps.vendorSandboxId;
    this.rootDir = deps.rootDir;
    this.projectId = deps.projectId;
    this.userId = deps.userId;
    this.timeoutMs = deps.timeoutMs;
    this.vCpus = deps.vCpus;
    this.memMiB = deps.memMiB;
    this.hostOs = deps.hostOs;
    this.macosProfilePath = deps.macosProfilePath;
    this.emitter = deps.emitter;
    this.sessionRepo = deps.sessionRepo;
    this.now = deps.now ?? (() => Date.now());
    this.createdAtMs = this.now();
    this.createdAt = new Date(this.createdAtMs);
  }

  // Inherit noop's symbolic kernel. `runCode` is intentionally simple
  // — the value of local-dev is shell-command isolation, not Python REPL.
  async runCode(code: string, opts?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();
    const start = this.now();
    // Local-dev does not provide a stateful kernel — emit a deterministic
    // result so call sites that rely on `runCode` still get a valid
    // ExecResult shape. Production code wanting kernel semantics MUST
    // use the E2B or Daytona adapter.
    const stdout = "";
    const stderr = "";
    opts?.onStdout?.(stdout);
    const result: ExecResult = {
      exitCode: 0,
      stdout,
      stderr,
      durationMs: this.now() - start,
    };
    await this.emitExec("exec", code, result);
    return result;
  }

  commands = {
    run: async (command: string, opts?: ExecOptions): Promise<ExecResult> => {
      this.assertAlive();
      const timeoutMs = clampInt(opts?.timeoutMs ?? this.timeoutMs, 100, this.timeoutMs);
      const start = this.now();
      const cwd = opts?.cwd ? this.resolveInside(opts.cwd) : this.rootDir;
      const argv = this.buildArgv(command, cwd);
      const result = await spawnArgv({
        bin: argv.bin,
        args: argv.args,
        cwd,
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
    const wallClockMs = this.now() - this.createdAtMs;
    const outcome: SandboxOutcome = this.timedOut ? "timeout" : "completed";
    const cost = calculateSandboxCost({
      provider: this.provider,
      wallClockMs,
      vCpus: this.vCpus,
      memMiB: this.memMiB,
      createdAt: this.createdAt,
    });
    try {
      await rm(this.rootDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    try {
      await this.sessionRepo.finalize(this.id, {
        destroyedAt: new Date(),
        wallClockMs,
        outcome,
        costMicroUsd: cost.rate ? cost.costMicroUsd : null,
      });
    } catch {
      /* best-effort */
    }
    await this.emitter.emit(this.ctx(), this.timedOut ? "timeout" : "destroy", {
      durationMs: wallClockMs,
      outcome,
      costMicroUsd: cost.rate ? cost.costMicroUsd : null,
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildArgv(command: string, cwd: string): { bin: string; args: string[] } {
    if (this.hostOs === "linux") {
      return buildBwrapArgv({ cwd, command });
    }
    // macOS: sandbox-exec -D SANDBOX_DIR=<cwd> -f <profile> /bin/sh -c <cmd>
    if (!this.macosProfilePath) {
      throw new Error("macosProfilePath is required when hostOs='darwin'");
    }
    return {
      bin: "sandbox-exec",
      args: ["-D", `SANDBOX_DIR=${cwd}`, "-f", this.macosProfilePath, "/bin/sh", "-c", command],
    };
  }

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`local-dev sandbox ${this.id} is destroyed`);
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

  private async killWithReason(reason: string, message: string): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
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
      /* best-effort */
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

interface SpawnArgvOpts {
  bin: string;
  args: string[];
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

async function spawnArgv(opts: SpawnArgvOpts): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolvePromise) => {
    // shell:false — argv comes in pre-tokenised; the command body is the
    // last positional arg of `bwrap` / `sandbox-exec` and is itself
    // wrapped in `/bin/sh -c`, so shell features still work.
    const child = spawn(opts.bin, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      shell: false,
    });
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let timedOut = false;
    const cap = SANDBOX_HARD_LIMITS.maxStreamCaptureBytes;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    child.stdout?.on("data", (data: Buffer) => {
      const remaining = cap - stdoutLen;
      const chunk = data.toString("utf8");
      if (remaining <= 0) {
        truncated = true;
      } else if (data.byteLength > remaining) {
        stdoutChunks.push(data.subarray(0, remaining).toString("utf8"));
        stdoutLen += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += data.byteLength;
      }
      opts.onStdout?.(chunk);
    });
    child.stderr?.on("data", (data: Buffer) => {
      const remaining = cap - stderrLen;
      const chunk = data.toString("utf8");
      if (remaining <= 0) {
        truncated = true;
      } else if (data.byteLength > remaining) {
        stderrChunks.push(data.subarray(0, remaining).toString("utf8"));
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
