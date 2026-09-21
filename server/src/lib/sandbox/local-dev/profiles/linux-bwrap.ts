/**
 * Linux bubblewrap (`bwrap`) argv builder for the local-dev sandbox
 * (Epic #395 #417).
 *
 * Per research §2.6 — `bwrap` is the basis for Claude Code's `/sandbox`
 * on Linux. The default profile drops every namespace except a fresh
 * `/tmp`, makes the host root read-only, and runs the requested
 * command via `/bin/sh -c`.
 *
 * This is single-process isolation only — `bwrap` shares the host
 * kernel and is NOT a substitute for the E2B / Daytona microVM
 * isolation in production.
 */
export interface BwrapBuildOptions {
  /** Absolute path to the sandbox working directory (mounted as the cwd). */
  cwd: string;
  /** Shell command line (passed verbatim to `/bin/sh -c`). */
  command: string;
  /** Optional extra read-only bind mounts (host -> sandbox path pairs). */
  extraReadOnlyBinds?: ReadonlyArray<readonly [string, string]>;
}

const DEFAULT_BWRAP_FLAGS: readonly string[] = [
  // Drop every namespace by default — caller must opt back into network.
  "--unshare-all",
  // Kill the sandbox if the parent exits (no orphaned bwrap on host).
  "--die-with-parent",
  // Make the host root read-only — model-generated commands cannot
  // mutate the developer's machine.
  "--ro-bind",
  "/",
  "/",
  // Fresh in-memory tmpfs for /tmp so writes don't pollute the host.
  "--tmpfs",
  "/tmp",
  // Standard /proc and /dev so basic shell tooling works.
  "--proc",
  "/proc",
  "--dev",
  "/dev",
];

/**
 * Build the argv for a single `bwrap` invocation. Returns `[bin, ...args]`
 * suitable for `child_process.spawn`. The returned argv places `--bind`
 * for the working directory FIRST so it overrides the read-only host
 * root binding.
 */
export function buildBwrapArgv(opts: BwrapBuildOptions): { bin: string; args: string[] } {
  const args: string[] = [...DEFAULT_BWRAP_FLAGS];

  // Bind the sandbox working directory read-write (after --ro-bind / so it overrides).
  args.push("--bind", opts.cwd, opts.cwd);

  for (const [hostPath, sandboxPath] of opts.extraReadOnlyBinds ?? []) {
    args.push("--ro-bind", hostPath, sandboxPath);
  }

  // Change directory inside the sandbox before exec.
  args.push("--chdir", opts.cwd);

  // Final argv: `/bin/sh -c <command>` so shell features (pipes,
  // redirects, env expansion) work the same way the noop adapter does.
  args.push("/bin/sh", "-c", opts.command);
  return { bin: "bwrap", args };
}
