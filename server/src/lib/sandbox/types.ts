/**
 * Sandbox port (Epic #395 #409).
 *
 * Hex-architecture interface that every concrete provider (E2B, Daytona,
 * Noop, future self-hosted) implements. The shape is the LCD of the v1
 * vendor SDKs (E2B `@e2b/code-interpreter` 2.4.x and Daytona TS SDK):
 *
 *   create / runCode / commands.run / files.{read,write} / pause / resume /
 *   destroy
 *
 * Every method has explicit timeout + cancellation semantics so adapters
 * cannot leak microVMs via uncaught errors. Streaming stdio is delivered
 * via `ExecOptions.onStdout` / `onStderr` callbacks so callers never need
 * to buffer multi-megabyte logs in memory.
 *
 * Application code MUST go through `getSandboxProvider()` (DI seam) — no
 * direct vendor SDK imports anywhere outside `server/src/lib/sandbox/`.
 */

/** Stable identifier for a vendor backend. */
export type SandboxProviderKind = "e2b" | "daytona" | "noop" | "local_dev" | "self_hosted";

/** Lifecycle / IO event types that flow into `SandboxAuditEvent`. */
export type SandboxAuditEventType =
  | "create"
  | "exec"
  | "upload"
  | "download"
  | "pause"
  | "resume"
  | "destroy"
  | "timeout";

/** Terminal outcome recorded on `SandboxSession.outcome`. */
export type SandboxOutcome = "completed" | "timeout" | "killed" | "error";

/** Options for `SandboxProvider.create`. */
export interface SandboxOptions {
  /** Project owning this sandbox — used for tenant isolation + per-project clamps. */
  projectId: string;
  /** Optional acting user id (system jobs may omit). */
  userId?: string | null;
  /**
   * Optional `AgentRun.id` this sandbox belongs to. Persisted on
   * `SandboxSession.runId` so the UI can render per-run session history
   * on the Run detail page (#419). System jobs may omit.
   */
  runId?: string | null;
  /** Wall-clock cap (ms). Clamped to `[1000, SANDBOX_HARD_LIMITS.maxWallClockMs]`. */
  timeoutMs?: number;
  /** Logical CPU count. Clamped to `[1, SANDBOX_HARD_LIMITS.maxVCpus]`. */
  vCpus?: number;
  /** Memory cap (MiB). Clamped to `[128, SANDBOX_HARD_LIMITS.maxMemMiB]`. */
  memMiB?: number;
  /** Vendor template identifier — provider-specific. */
  templateId?: string;
  /** Per-call hostnames to merge with system-default egress allowlist. */
  egressAllowlist?: readonly string[];
  /** Project-level configuration override (read by adapters via clampSandboxOptions). */
  projectConfig?: SandboxProjectConfig;
}

/** Subset of `Project` columns the sandbox layer reads. */
export interface SandboxProjectConfig {
  /** `Project.sandboxTimeoutMs`. Tightens the call-site request. */
  sandboxTimeoutMs?: number;
  /** `Project.sandboxEgressAllowlist` as a JSON-decoded list. */
  sandboxEgressAllowlist?: readonly string[];
}

/** Options accepted by `runCode`/`commands.run`. */
export interface ExecOptions {
  /** Per-call wall-clock cap (ms). Defaults to the sandbox-level timeout. */
  timeoutMs?: number;
  /** Working directory inside the sandbox. */
  cwd?: string;
  /** Extra environment variables (merged on top of vendor defaults). */
  env?: Record<string, string>;
  /** Streaming stdout callback — invoked for each chunk; never buffered. */
  onStdout?: (chunk: string) => void;
  /** Streaming stderr callback — invoked for each chunk; never buffered. */
  onStderr?: (chunk: string) => void;
}

/** Result of a single `runCode`/`commands.run` invocation. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when stdout/stderr were truncated due to a per-stream byte cap. */
  truncated?: boolean;
}

/** Read-file options. */
export interface ReadFileOptions {
  format?: "utf8" | "bytes";
}

/** Single created sandbox. Methods are safe to call concurrently. */
export interface Sandbox {
  /** Stable identifier (matches `SandboxSession.id`). */
  readonly id: string;
  /** Vendor-side identifier (matches `SandboxSession.vendorSandboxId`). */
  readonly vendorSandboxId: string;
  /** The provider kind that created this sandbox. */
  readonly provider: SandboxProviderKind;
  /** Stateful kernel-style code execution (variables persist within a session). */
  runCode(code: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Shell command execution. */
  commands: {
    run(command: string, opts?: ExecOptions): Promise<ExecResult>;
  };
  /** File IO inside the sandbox filesystem. */
  files: {
    read(path: string, opts?: ReadFileOptions): Promise<string | Uint8Array>;
    write(path: string, data: string | Uint8Array): Promise<void>;
  };
  /** Pause the sandbox; returns a snapshot id usable with `resume`. */
  pause(): Promise<string>;
  /** Resume a previously paused sandbox from a snapshot id. */
  resume(snapshotId: string): Promise<void>;
  /** Tear down the sandbox; idempotent; emits `destroy` audit event. */
  destroy(): Promise<void>;
}

/** Vendor-agnostic factory. */
export interface SandboxProvider {
  readonly kind: SandboxProviderKind;
  create(opts: SandboxOptions): Promise<Sandbox>;
}

/** Thrown when a `create()` request would exceed `SANDBOX_HARD_LIMITS`. */
export class SandboxLimitExceededError extends Error {
  constructor(
    public readonly limit: string,
    public readonly requested: number,
    public readonly maximum: number,
  ) {
    super(`Sandbox limit '${limit}' exceeded: requested ${requested}, max ${maximum}`);
    this.name = "SandboxLimitExceededError";
  }
}

/** Thrown when the watchdog kills a sandbox that exceeded its wall-clock cap. */
export class SandboxTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Sandbox exceeded wall-clock timeout of ${timeoutMs}ms`);
    this.name = "SandboxTimeoutError";
  }
}

/** Thrown when an egress allowlist contains a forbidden wildcard. */
export class SandboxEgressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxEgressValidationError";
  }
}
