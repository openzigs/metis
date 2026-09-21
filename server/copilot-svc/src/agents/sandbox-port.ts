/**
 * Local mirror of the `Sandbox` port (Epic #395 #415).
 *
 * Defined inside `copilot-svc` so this package never reaches into
 * `server/src/lib/sandbox/` (the AC for #415 forbids vendor SDK imports
 * here, and the simplest way to enforce that is to forbid imports out
 * of the package boundary entirely). The shape is the LCD of the real
 * port — adapters in `server/src/lib/sandbox/` are structurally
 * compatible without any cross-package coupling.
 */

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export interface SandboxLike {
  readonly id: string;
  commands: {
    run(command: string, opts?: ExecOptions): Promise<ExecResult>;
  };
  files: {
    write(path: string, data: string | Uint8Array): Promise<void>;
  };
  destroy(): Promise<void>;
}

export interface SandboxLikeProvider {
  create(opts: {
    projectId: string;
    userId?: string | null;
    timeoutMs?: number;
  }): Promise<SandboxLike>;
}
