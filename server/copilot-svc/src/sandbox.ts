/**
 * Epic #192 (A.1) — E2B sandbox executor.
 *
 * Runs untrusted code inside an isolated Firecracker microVM provisioned
 * through the E2B SDK. The SDK is **not** declared in `package.json` so the
 * slim copilot-svc image stays under the 350 MB ceiling (Epic A acceptance
 * criterion). It is dynamically imported on demand via {@link defaultFactory},
 * and tests inject an in-memory factory through {@link setSandboxFactory}.
 *
 * Hard limits enforced here regardless of the requested timeout:
 *   - default 30s timeout, hard cap 120s.
 *   - 64 KiB stdout / 64 KiB stderr (anything longer is truncated and
 *     `truncated: true` is set on the response).
 *
 * Failure modes surface as typed errors:
 *   - {@link SandboxConfigError} when `E2B_API_KEY` is missing.
 *   - {@link SandboxTimeoutError} when the run exceeds the deadline.
 *   - {@link SandboxUnavailableError} when the SDK cannot be loaded
 *     (e.g. the optional dep is not installed in the running image).
 */

export type SandboxLanguage = "python" | "node" | "bash";

export interface SandboxRunInput {
  language: SandboxLanguage;
  code: string;
  timeoutMs?: number;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
}

export interface SandboxLike {
  runCode(input: SandboxRunInput & { timeoutMs: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    durationMs: number;
  }>;
  close(): Promise<void>;
}

export type SandboxFactory = (apiKey: string) => Promise<SandboxLike>;

export const MAX_OUTPUT_BYTES = 64 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const HARD_TIMEOUT_MS = 120_000;

export class SandboxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxConfigError";
  }
}

export class SandboxTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}

export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

let factoryOverride: SandboxFactory | null = null;

/** Test seam — inject a stub factory so tests never reach the real SDK. */
export function setSandboxFactory(factory: SandboxFactory | null): void {
  factoryOverride = factory;
}

/** Returns true when an E2B API key is configured (used by /healthz). */
export function isSandboxConfigured(): boolean {
  return !!process.env.E2B_API_KEY?.trim();
}

function clampTimeout(requested: number | undefined): number {
  const t =
    typeof requested === "number" && Number.isFinite(requested) ? requested : DEFAULT_TIMEOUT_MS;
  return Math.min(Math.max(1_000, Math.trunc(t)), HARD_TIMEOUT_MS);
}

function truncate(s: string): { value: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.byteLength <= MAX_OUTPUT_BYTES) return { value: s, truncated: false };
  return { value: buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8"), truncated: true };
}

/**
 * Default factory — lazy-imports `@e2b/sdk` (an optional runtime dependency).
 * When the import fails (slim image without the SDK), throws
 * {@link SandboxUnavailableError} so callers can degrade gracefully.
 */
async function defaultFactory(apiKey: string): Promise<SandboxLike> {
  let sdk: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk = (await import("@e2b/sdk" as string)) as any;
  } catch {
    throw new SandboxUnavailableError(
      "@e2b/sdk is not installed in this image. Build with the sandbox tag or set SANDBOX_MODE to off.",
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Sandbox = (sdk as any)?.Sandbox ?? (sdk as any)?.default;
  if (!Sandbox || typeof Sandbox.create !== "function") {
    throw new SandboxUnavailableError("@e2b/sdk shape changed — Sandbox.create not found");
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const session: any = await Sandbox.create({ apiKey });
  return {
    async runCode(input) {
      const start = Date.now();
      const cmd = buildCommand(input.language, input.code);
      const proc = await session.process.start({ cmd });
      const result = await proc.wait({ timeoutMs: input.timeoutMs });
      return {
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? ""),
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
        durationMs: Date.now() - start,
      };
    },
    async close() {
      try {
        await session.close();
      } catch {
        /* swallow — best-effort destruction */
      }
    },
  };
}

function buildCommand(language: SandboxLanguage, code: string): string {
  const escaped = code.replace(/'/g, "'\\''");
  switch (language) {
    case "python":
      return `python3 -c '${escaped}'`;
    case "node":
      return `node -e '${escaped}'`;
    case "bash":
      return `bash -c '${escaped}'`;
  }
}

/**
 * Provision a sandbox, run the code, and tear the sandbox down. Sandboxes
 * are NOT pooled in v1.2 — every exec is a fresh microVM (matches the
 * "destroy at run end" requirement in the epic spec).
 */
export async function execInSandbox(input: SandboxRunInput): Promise<SandboxRunResult> {
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) {
    throw new SandboxConfigError("E2B_API_KEY is not configured");
  }
  if (!input.code || typeof input.code !== "string") {
    throw new SandboxConfigError("code is required");
  }
  const timeoutMs = clampTimeout(input.timeoutMs);
  const factory = factoryOverride ?? defaultFactory;
  const sandbox = await factory(apiKey);
  const deadline = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new SandboxTimeoutError(`sandbox exec exceeded ${timeoutMs}ms`)),
      timeoutMs + 5_000,
    ),
  );
  try {
    const raw = await Promise.race([sandbox.runCode({ ...input, timeoutMs }), deadline]);
    const stdout = truncate(raw.stdout);
    const stderr = truncate(raw.stderr);
    return {
      stdout: stdout.value,
      stderr: stderr.value,
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
      truncated: stdout.truncated || stderr.truncated,
    };
  } finally {
    try {
      await sandbox.close();
    } catch {
      /* swallow */
    }
  }
}
