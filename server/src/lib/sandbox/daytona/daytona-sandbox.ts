/**
 * Daytona sandbox (Epic #395 #416).
 *
 * Adapter wrapping `@daytona/sdk`. Implements the `Sandbox` port —
 * `runCode` is stateful (Daytona's `process.codeRun` exposes a
 * persistent kernel), `commands.run` maps to `process.executeCommand`,
 * file IO maps to `fs.uploadFile` / `fs.downloadFile`. Adapter MUST
 * be the only place the SDK is imported (DI through the provider).
 */
import type { SandboxAuditEmitter } from "../audit/audit-emitter.js";
import { SANDBOX_HARD_LIMITS } from "../limits.js";
import { calculateSandboxCost } from "../pricing/calculator.js";
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

/**
 * Subset of `@daytona/sdk`'s `Sandbox` we depend on. The real SDK
 * exposes `process` (codeRun + executeCommand), `fs` (uploadFile +
 * downloadFile), and `delete` for teardown.
 */
export interface DaytonaSandboxLike {
  readonly id?: string;
  process: {
    codeRun(
      code: string,
      opts?: { timeout?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void },
    ): Promise<DaytonaExecution>;
    executeCommand(
      cmd: string,
      cwd?: string,
      env?: Record<string, string>,
      timeoutMs?: number,
    ): Promise<DaytonaCommandResult>;
  };
  fs: {
    uploadFile(content: string | Uint8Array, remotePath: string): Promise<void>;
    downloadFile(remotePath: string): Promise<Uint8Array>;
  };
  delete(): Promise<void>;
}

interface DaytonaExecution {
  result?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string | null;
}

interface DaytonaCommandResult {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  result?: string;
}

export interface DaytonaSandboxDeps {
  sessionId: string;
  vendorSandboxId: string;
  projectId: string;
  userId: string | null;
  client: DaytonaSandboxLike;
  timeoutMs: number;
  vCpus: number;
  memMiB: number;
  emitter: SandboxAuditEmitter;
  sessionRepo: SandboxSessionRepo;
  now?: () => number;
}

export class DaytonaSandbox implements Sandbox {
  readonly id: string;
  readonly vendorSandboxId: string;
  readonly provider: SandboxProviderKind = "daytona";

  private readonly client: DaytonaSandboxLike;
  private readonly projectId: string;
  private readonly userId: string | null;
  private readonly timeoutMs: number;
  private readonly vCpus: number;
  private readonly memMiB: number;
  private readonly emitter: SandboxAuditEmitter;
  private readonly sessionRepo: SandboxSessionRepo;
  private readonly now: () => number;
  private readonly createdAtMs: number;
  private readonly createdAt: Date;
  private destroyed = false;
  private timedOut = false;

  constructor(deps: DaytonaSandboxDeps) {
    this.id = deps.sessionId;
    this.vendorSandboxId = deps.vendorSandboxId;
    this.client = deps.client;
    this.projectId = deps.projectId;
    this.userId = deps.userId;
    this.timeoutMs = deps.timeoutMs;
    this.vCpus = deps.vCpus;
    this.memMiB = deps.memMiB;
    this.emitter = deps.emitter;
    this.sessionRepo = deps.sessionRepo;
    this.now = deps.now ?? (() => Date.now());
    this.createdAtMs = this.now();
    this.createdAt = new Date(this.createdAtMs);
  }

  async runCode(code: string, opts?: ExecOptions): Promise<ExecResult> {
    this.assertAlive();
    const start = this.now();
    const exec = await this.client.process.codeRun(code, {
      timeout: opts?.timeoutMs ?? this.timeoutMs,
      ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts?.onStderr ? { onStderr: opts.onStderr } : {}),
    });
    const stdout = exec.result ?? exec.stdout ?? "";
    const stderr = exec.stderr ?? exec.error ?? "";
    const exitCode = typeof exec.exitCode === "number" ? exec.exitCode : exec.error ? 1 : 0;
    const result: ExecResult = {
      exitCode,
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
      const start = this.now();
      const out = await this.client.process.executeCommand(
        command,
        opts?.cwd,
        opts?.env,
        opts?.timeoutMs ?? this.timeoutMs,
      );
      const stdout = out.stdout ?? out.result ?? "";
      const stderr = out.stderr ?? "";
      // Stream callbacks for parity with E2B — Daytona doesn't natively
      // stream, so we emit one final chunk after the call resolves.
      if (stdout && opts?.onStdout) opts.onStdout(stdout);
      if (stderr && opts?.onStderr) opts.onStderr(stderr);
      const result: ExecResult = {
        exitCode: out.exitCode,
        stdout,
        stderr,
        durationMs: this.now() - start,
      };
      await this.emitExec("exec", command, result);
      return result;
    },
  };

  files = {
    read: async (path: string, opts?: ReadFileOptions): Promise<string | Uint8Array> => {
      this.assertAlive();
      const bytes = await this.client.fs.downloadFile(path);
      await this.emitter.emit(this.ctx(), "download", { path, bytes: bytes.byteLength });
      if (opts?.format === "bytes") return bytes;
      return Buffer.from(bytes).toString("utf8");
    },
    write: async (path: string, data: string | Uint8Array): Promise<void> => {
      this.assertAlive();
      const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
      if (bytes > SANDBOX_HARD_LIMITS.maxFileWriteBytes) {
        await this.emitter.emit(this.ctx(), "upload", {
          path,
          bytes,
          reason: "file_size_cap_exceeded",
        });
        await this.killWithReason(
          "file_size_cap_exceeded",
          `file write exceeds ${SANDBOX_HARD_LIMITS.maxFileWriteBytes} bytes`,
        );
        throw new SandboxLimitExceededError(
          "fileWriteBytes",
          bytes,
          SANDBOX_HARD_LIMITS.maxFileWriteBytes,
        );
      }
      await this.client.fs.uploadFile(data, path);
      await this.emitter.emit(this.ctx(), "upload", { path, bytes });
    },
  };

  async pause(): Promise<string> {
    // Daytona snapshots are an async control-plane operation; v1.2 does
    // not expose them through the port. Surface a stable stub id so the
    // contract holds and audit captures the intent.
    this.assertAlive();
    const snapshotId = `daytona-pause-${this.id}`;
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
      await this.client.delete();
    } catch {
      /* SDK delete failures downgraded — emitter records below */
    }
    try {
      await this.sessionRepo.finalize(this.id, {
        destroyedAt: new Date(),
        wallClockMs,
        outcome,
        costMicroUsd: cost.rate ? cost.costMicroUsd : null,
      });
    } catch {
      /* finalize failures must not block destroy */
    }
    await this.emitter.emit(this.ctx(), this.timedOut ? "timeout" : "destroy", {
      durationMs: wallClockMs,
      outcome,
      costMicroUsd: cost.rate ? cost.costMicroUsd : null,
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private assertAlive(): void {
    if (this.destroyed) {
      throw new Error(`Daytona sandbox ${this.id} is destroyed`);
    }
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
    this.timedOut = false;
    const wallClockMs = this.now() - this.createdAtMs;
    try {
      await this.client.delete();
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
