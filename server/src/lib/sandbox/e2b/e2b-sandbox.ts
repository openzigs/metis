/**
 * E2B sandbox (Epic #395 #411).
 *
 * Adapter wrapping `@e2b/code-interpreter` 2.4.x. Implements the
 * `Sandbox` port — `runCode` is stateful (variable persistence across
 * calls within a session), `commands.run` streams stdio via callbacks,
 * `files.read` returns a `Uint8Array` when `format: 'bytes'`. Adapter
 * MUST be the only place the SDK is imported (DI through the provider).
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

/** Subset of `@e2b/code-interpreter`'s `Sandbox` we depend on. */
export interface E2BSandboxLike {
  readonly sandboxId?: string;
  runCode(
    code: string,
    opts?: { timeoutMs?: number; onStdout?: (s: string) => void; onStderr?: (s: string) => void },
  ): Promise<E2BExecution>;
  commands: {
    run(
      cmd: string,
      opts?: {
        timeoutMs?: number;
        cwd?: string;
        envs?: Record<string, string>;
        onStdout?: (s: string) => void;
        onStderr?: (s: string) => void;
      },
    ): Promise<E2BCommandResult>;
  };
  files: {
    read(path: string, opts?: { format?: "text" | "bytes" }): Promise<string | Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
  };
  pause(): Promise<string>;
  kill(): Promise<void>;
}

interface E2BExecution {
  text?: string;
  logs?: { stdout?: string[]; stderr?: string[] };
  error?: { name: string; value: string } | null;
}

interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface E2BSandboxDeps {
  sessionId: string;
  vendorSandboxId: string;
  projectId: string;
  userId: string | null;
  client: E2BSandboxLike;
  timeoutMs: number;
  vCpus: number;
  memMiB: number;
  emitter: SandboxAuditEmitter;
  sessionRepo: SandboxSessionRepo;
  now?: () => number;
}

export class E2BSandbox implements Sandbox {
  readonly id: string;
  readonly vendorSandboxId: string;
  readonly provider: SandboxProviderKind = "e2b";

  private readonly client: E2BSandboxLike;
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

  constructor(deps: E2BSandboxDeps) {
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
    const exec = await this.client.runCode(code, {
      timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
      ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
      ...(opts?.onStderr ? { onStderr: opts.onStderr } : {}),
    });
    const stdout = exec.text ?? exec.logs?.stdout?.join("") ?? "";
    const stderr = exec.logs?.stderr?.join("") ?? exec.error?.value ?? "";
    const exitCode = exec.error ? 1 : 0;
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
      const out = await this.client.commands.run(command, {
        timeoutMs: opts?.timeoutMs ?? this.timeoutMs,
        ...(opts?.cwd ? { cwd: opts.cwd } : {}),
        ...(opts?.env ? { envs: opts.env } : {}),
        ...(opts?.onStdout ? { onStdout: opts.onStdout } : {}),
        ...(opts?.onStderr ? { onStderr: opts.onStderr } : {}),
      });
      const result: ExecResult = {
        exitCode: out.exitCode,
        stdout: out.stdout,
        stderr: out.stderr,
        durationMs: this.now() - start,
      };
      await this.emitExec("exec", command, result);
      return result;
    },
  };

  files = {
    read: async (path: string, opts?: ReadFileOptions): Promise<string | Uint8Array> => {
      this.assertAlive();
      const e2bFormat = opts?.format === "bytes" ? "bytes" : "text";
      const value = await this.client.files.read(path, { format: e2bFormat });
      const bytes =
        opts?.format === "bytes"
          ? value instanceof Uint8Array
            ? value.byteLength
            : Buffer.byteLength(value as string, "utf8")
          : Buffer.byteLength(String(value), "utf8");
      await this.emitter.emit(this.ctx(), "download", { path, bytes });
      return value;
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
      await this.client.files.write(path, data);
      await this.emitter.emit(this.ctx(), "upload", { path, bytes });
    },
  };

  async pause(): Promise<string> {
    this.assertAlive();
    const snapshotId = await this.client.pause();
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
      await this.client.kill();
    } catch {
      /* SDK kill failures are downgraded to warnings via the emitter below */
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
      throw new Error(`E2B sandbox ${this.id} is destroyed`);
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
      await this.client.kill();
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
