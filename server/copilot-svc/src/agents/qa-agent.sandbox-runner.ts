/**
 * QA-agent sandbox runner (Epic #395 #415).
 *
 * Pure function that:
 *   1. Uploads project files into a `Sandbox`.
 *   2. Runs the test command.
 *   3. Returns a structured `TestRunResult` so the BA loop can decide
 *      whether to iterate.
 *
 * No vendor SDK is imported anywhere under `server/copilot-svc/` — only
 * the `SandboxLike` port mirror defined in `./sandbox-port.ts`. The
 * upstream lifecycle (create + finally destroy) lives in
 * {@link runTestsWithProvider}.
 */
import type { SandboxLike, SandboxLikeProvider } from "./sandbox-port.js";

export interface ProjectFile {
  /** Absolute or relative path inside the sandbox filesystem. */
  path: string;
  /** UTF-8 encoded file contents. */
  contents: string;
}

export interface RunTestsInput {
  files: readonly ProjectFile[];
  /** Shell command — e.g. `"npm test"`, `"pytest -q"`. */
  testCommand: string;
  /** Working directory inside the sandbox. Defaults to `/workspace`. */
  cwd?: string;
  /** Per-call timeout (ms). Defaults to the sandbox-level timeout. */
  timeoutMs?: number;
}

export interface TestRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Convenience flag — `exitCode === 0 && !timedOut`. */
  passed: boolean;
  timedOut: boolean;
}

/** Sentinel exit code used when the sandbox watchdog killed the run. */
export const TIMEOUT_EXIT_CODE = -1;

/**
 * Upload + run + collect result. Does NOT destroy the sandbox — the
 * caller (or {@link runTestsWithProvider}) owns the lifecycle.
 */
export async function runTestsInSandbox(
  sandbox: SandboxLike,
  input: RunTestsInput,
): Promise<TestRunResult> {
  const cwd = input.cwd ?? "/workspace";
  for (const file of input.files) {
    const path = file.path.startsWith("/") ? file.path : `${cwd}/${file.path}`;
    await sandbox.files.write(path, file.contents);
  }
  try {
    const result = await sandbox.commands.run(input.testCommand, {
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      cwd,
    });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      passed: result.exitCode === 0,
      timedOut: false,
    };
  } catch (err) {
    // Treat any error from `commands.run` as a timeout iff the message
    // says so; otherwise surface as a generic failure with exitCode 1.
    const message = (err as Error).message ?? String(err);
    const timedOut = /timeout|timed out|watchdog/i.test(message);
    return {
      exitCode: timedOut ? TIMEOUT_EXIT_CODE : 1,
      stdout: "",
      stderr: timedOut ? `sandbox timeout: ${message}` : message,
      durationMs: 0,
      passed: false,
      timedOut,
    };
  }
}

/**
 * Full lifecycle wrapper used by the QA agent: provision a sandbox via
 * the DI-injected provider, run the test, ALWAYS destroy in a
 * `finally`. AC: `SandboxSession.destroyedAt IS NOT NULL` after this
 * function resolves regardless of outcome.
 */
export async function runTestsWithProvider(
  provider: SandboxLikeProvider,
  createOpts: { projectId: string; userId?: string | null; timeoutMs?: number },
  input: RunTestsInput,
): Promise<TestRunResult> {
  const sandbox = await provider.create(createOpts);
  try {
    return await runTestsInSandbox(sandbox, input);
  } finally {
    try {
      await sandbox.destroy();
    } catch {
      /* destroy errors must not mask the test result */
    }
  }
}
