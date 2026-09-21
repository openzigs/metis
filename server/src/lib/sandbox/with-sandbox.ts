/**
 * `withSandbox()` — generic try/finally helper used by every adapter
 * (Epic #395 #411).
 *
 * Guarantees the sandbox is destroyed even when the caller throws. Used
 * by routes/agents that don't manage their own lifecycle:
 *
 * ```ts
 *   const result = await withSandbox(provider, opts, async (sandbox) => {
 *     return sandbox.commands.run("npm test");
 *   });
 * ```
 */
import type { Sandbox, SandboxOptions, SandboxProvider } from "./types.js";

export async function withSandbox<T>(
  provider: SandboxProvider,
  opts: SandboxOptions,
  fn: (sandbox: Sandbox) => Promise<T>,
): Promise<T> {
  const sandbox = await provider.create(opts);
  try {
    return await fn(sandbox);
  } finally {
    try {
      await sandbox.destroy();
    } catch {
      /* destroy errors must not mask the caller's result/error */
    }
  }
}
