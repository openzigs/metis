/**
 * #1512 — the unit suite's egress guard.
 *
 * A unit test must not reach the network: `connector-routes.test.ts` once made a real
 * `git clone https://github.com/octocat/demo` through `triggerDeepIngest` →
 * `shallowCloneRepo`, so its result depended on connectivity and on GitHub. The code
 * under test swallowed the failure (`CLONE_FAILED`), so the test stayed green either way.
 *
 * Two choke points, because one alone misses a class of egress:
 *
 * - `net.Socket.prototype.connect` — every in-process TCP/TLS connection (`http`,
 *   `https`, `tls`, the global `fetch`/undici, database and Redis drivers) goes through
 *   it. A non-loopback destination is refused.
 * - `ChildProcess.prototype.spawn` (plus the exported sync spawners) — a spawned `git`
 *   opens its own sockets in another process, which no in-process hook can see. That is
 *   exactly the #1512 path, so a socket guard alone would not have caught it. A `git`
 *   that would reach a non-local repository is refused: one naming a remote URL, or a
 *   network subcommand (`fetch`, `pull`, `push`, `ls-remote`, `submodule`,
 *   `remote update|show|prune`) whose configured remote is not local.
 *
 * A refused connection fails like a real one (an `ENETUNREACH` socket error, or a git
 * that exits 128 after printing {@link BLOCKED_MARKER}), so the code under test sees an
 * ordinary network failure. A raw `new net.Socket().connect()` with no `error` listener
 * therefore surfaces the refusal as an unhandled `ENETUNREACH`. Because the code under
 * test may swallow the failure, every refusal is ALSO recorded, and the setup file fails
 * the test in `afterEach`/`afterAll` — the refusal cannot be caught away.
 *
 * Known gaps (also in docs/DEVELOPMENT.md): DNS queries (`dns.lookup`/`dns.resolve*`) and
 * `dgram` are not hooked; a `worker_threads` Worker has its own `net` and is unguarded;
 * spawned tools other than git (`curl`, `npx -y`, a child `node`) are not inspected; and a
 * fire-and-forget refusal is reported by whichever test drains next (the message names
 * the test that was running when it happened).
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as ChildProcessModule from "node:child_process";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);

/** Printed by the stand-in for a refused git, so a test can tell it from a real git failure. */
export const BLOCKED_MARKER = "metis-egress-guard: refused (#1512)";
const BLOCKED_ARGS = [
  "-e",
  `process.stderr.write(${JSON.stringify(BLOCKED_MARKER + "\n")}); process.exit(128)`,
];

/** True for a host that can only name this machine. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null) return true; // net defaults to localhost
  let h = host.trim().toLowerCase();
  if (h === "") return true;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "::" || h === "0:0:0:0:0:0:0:1" || h === "0.0.0.0") return true;
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  return /^127(?:\.\d{1,3}){3}$/.test(v4);
}

/**
 * The host a git repository argument names, or null when it is a path or `file://`.
 * `bare` also reads the user-less scp form `host.tld:path`. A dot is required, so a
 * Windows drive `C:\…` or a refspec `main:main` is not a host. That form is ambiguous
 * with a revision path (`v1.2:file`), so it is only read where git expects a repository.
 */
export function remoteHostOf(arg: string, { bare = true }: { bare?: boolean } = {}): string | null {
  const url = /^(?:https?|git|ssh|ftps?):\/\//i.test(arg) ? safeUrl(arg) : null;
  if (url) return url.hostname || null;
  const scp = /^[\w.-]+@([\w.-]+):(?!\/\/)/.exec(arg);
  if (scp) return scp[1];
  const bareScp = bare ? /^([\w-]+(?:\.[\w-]+)+):(?!\/\/)/.exec(arg) : null;
  return bareScp ? bareScp[1] : null;
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** True for a repository that lives on this machine: a path, `file://`, or a loopback URL. */
export function isLocalRepo(urlOrPath: string, opts?: { bare?: boolean }): boolean {
  const host = remoteHostOf(urlOrPath, opts);
  return host === null || isLoopbackHost(host);
}

/** Git global options that take their value as the next argument. */
const GLOBAL_OPTS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--config-env",
]);

export interface GitArgs {
  /** Options before the subcommand (`-C dir`, `-c k=v`, …), kept to resolve remotes. */
  globalArgs: string[];
  subcommand: string | null;
  rest: string[];
}

export function parseGitArgs(args: readonly string[]): GitArgs {
  const globalArgs: string[] = [];
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) {
    globalArgs.push(args[i]);
    if (GLOBAL_OPTS_WITH_VALUE.has(args[i]) && i + 1 < args.length) globalArgs.push(args[++i]);
    i++;
  }
  return { globalArgs, subcommand: args[i] ?? null, rest: args.slice(i + 1) };
}

/** The remote (or submodule) names and URLs a repository has configured. */
export interface ConfiguredRemotes {
  names: string[];
  urls: string[];
}
/**
 * Reads the configured remotes of the repository git would run in; `null` when that
 * cannot be determined, which the guard treats as remote (fail closed).
 */
export type RemoteResolver = (
  git: string,
  globalArgs: string[],
  cwd: string | undefined,
  kind: "remote" | "submodule",
) => ConfiguredRemotes | null;

const NETWORK_SUBCOMMANDS = new Set(["fetch", "pull", "push", "ls-remote", "submodule", "remote"]);
const NETWORK_ACTIONS: Record<string, Set<string>> = {
  remote: new Set(["update", "show", "prune"]),
  submodule: new Set(["update", "add", "foreach"]),
};

function looksLikePath(arg: string): boolean {
  return /^(?:\/|\.{1,2}(?:\/|\\|$)|~|[a-z]:[\\/]|\\\\|file:)/i.test(arg);
}

function isGitBinary(file: string): boolean {
  const base = path.win32.basename(file.replace(/^['"]|['"]$/g, "")).toLowerCase();
  return base === "git" || base === "git.exe";
}

/**
 * True when `file args` is a git invocation that would reach a non-local repository:
 * an argument naming a remote URL, or a network subcommand whose repository — an
 * explicit path, else the configured remotes — is not local.
 */
export function isRemoteGitInvocation(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; resolve?: RemoteResolver } = {},
): boolean {
  if (!isGitBinary(file)) return false;
  const { globalArgs, subcommand, rest } = parseGitArgs(args);
  const positionals = rest.filter((a) => !a.startsWith("-"));
  const actions = subcommand === null ? undefined : NETWORK_ACTIONS[subcommand];
  // `git config …` and `git remote add|set-url …` only WRITE a URL; anything else naming
  // one (including `archive --remote=…`) is treated as reaching it.
  const writesUrlOnly =
    subcommand === "config" || (subcommand === "remote" && !actions!.has(positionals[0] ?? ""));
  const valueOf = (a: string) =>
    a.startsWith("-") && a.includes("=") ? a.slice(a.indexOf("=") + 1) : a;
  if (!writesUrlOnly && args.some((a) => !isLocalRepo(valueOf(a), { bare: false }))) return true;
  // The repository argument, where git expects one (`clone <repo>`, `fetch <repo>`,
  // `submodule add <repo>`); refspecs after it may contain `:` and are not repositories.
  const repoArg = subcommand === "submodule" ? positionals[1] : positionals[0];
  // `clone [--depth 1] <repo> [<dir>]`: an option value can shift the positionals.
  if (subcommand === "clone") return positionals.some((a) => !isLocalRepo(a));
  if (subcommand === null || !NETWORK_SUBCOMMANDS.has(subcommand)) return false;
  if (actions && !actions.has(positionals[0] ?? "")) return false;
  if (subcommand !== "remote" && repoArg !== undefined && !isLocalRepo(repoArg)) return true;
  const kind = subcommand === "submodule" ? "submodule" : "remote";
  const configured = opts.resolve ? opts.resolve(file, globalArgs, opts.cwd, kind) : null;
  if (configured === null) return true;
  // `git fetch /some/path …` names a local repository explicitly.
  const repo = kind === "remote" && subcommand !== "remote" ? positionals[0] : undefined;
  if (repo !== undefined && !configured.names.includes(repo) && looksLikePath(repo)) return false;
  return configured.urls.some((u) => !isLocalRepo(u));
}

/** Splits a shell command line into simple commands, each as unquoted tokens. */
export function shellCommands(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|&\n]/)
    .map((seg) =>
      seg
        .trim()
        .split(/\s+/)
        .map((t) => t.replace(/^['"]+|['"]+$/g, ""))
        .filter((t) => t !== ""),
    )
    .filter((tokens) => tokens.length > 0);
}

/** True when a shell command line runs git against a non-local repository. */
export function isRemoteGitCommand(
  command: string,
  opts: { cwd?: string; resolve?: RemoteResolver } = {},
): boolean {
  return shellCommands(command).some(
    ([file, ...args]) => isGitBinary(file) && isRemoteGitInvocation(file, args, opts),
  );
}

const SHELLS = /^(?:sh|bash|zsh|dash|ksh|cmd|cmd\.exe)$/i;

/** The command line a shell spawn runs: `sh -c "<line>"`, `cmd.exe /d /s /c "<line>"`. */
export function shellLineOf(file: string, argv: readonly string[]): string | null {
  if (!SHELLS.test(path.win32.basename(file))) return null;
  const i = argv.findIndex((a) => /^[-/]c$/i.test(a));
  return i === -1 || i === argv.length - 1 ? null : argv.slice(i + 1).join(" ");
}

type LookupCallback = (err: Error | null, address?: unknown, family?: number) => void;
type LookupFn = (hostname: string, options: unknown, cb: LookupCallback) => void;

export interface ConnectTarget {
  host: string | undefined;
  ipc: boolean;
  /** The caller's own resolver (`options.lookup`) — a pinned lookup, typically. */
  lookup?: LookupFn;
  options?: Record<string, unknown>;
  callback?: unknown;
}

/** The destination of a `Socket#connect` call; `ipc` for a unix socket / named pipe. */
export function connectTarget(args: unknown[]): ConnectTarget {
  let first = args[0];
  let callback = args[1];
  // net.connect() passes Socket#connect a pre-normalized `[options, cb]` array.
  if (Array.isArray(first)) {
    callback = first[1];
    first = first[0];
  }
  if (typeof first === "string") return { host: undefined, ipc: true }; // connect(path)
  if (typeof first === "number") {
    return { host: typeof args[1] === "string" ? args[1] : undefined, ipc: false };
  }
  if (first && typeof first === "object") {
    const o = first as Record<string, unknown>;
    if (typeof o.path === "string" && o.path !== "") return { host: undefined, ipc: true };
    return {
      host: typeof o.host === "string" ? o.host : undefined,
      ipc: false,
      lookup: typeof o.lookup === "function" ? (o.lookup as LookupFn) : undefined,
      options: o,
      callback,
    };
  }
  return { host: undefined, ipc: false };
}

/** Every address a `dns.lookup`-style callback delivered (single or `all: true` form). */
export function lookupAddresses(address: unknown): string[] {
  if (typeof address === "string") return [address];
  if (Array.isArray(address)) {
    return address
      .map((a) => (a && typeof a === "object" ? (a as { address?: unknown }).address : a))
      .filter((a): a is string => typeof a === "string");
  }
  return [];
}

/** Where the setup file publishes its guard, so the guard's own tests can drain it. */
export const ACTIVE_EGRESS_GUARD = Symbol.for("metis.egressGuard");

export interface EgressGuard {
  /** Remove and return every refusal recorded since the last drain. */
  drain(): string[];
  uninstall(): void;
}

export interface EgressGuardOptions {
  /** Return a reason to let an attempt through (an allowlisted suite), or null to refuse. */
  isAllowed?: () => string | null;
  /** Names what was running when a refusal happened (the current test), for the message. */
  context?: () => string | undefined;
}

/** Install both hooks. */
export function installEgressGuard(opts: EgressGuardOptions = {}): EgressGuard {
  const isAllowed = opts.isAllowed ?? (() => null);
  const violations: string[] = [];
  const record = (what: string) => {
    const where = opts.context?.();
    violations.push(`${what}${where ? ` [during: ${where}]` : ""} (#1512 egress guard)`);
  };
  const cp = require("node:child_process") as typeof ChildProcessModule & {
    ChildProcess: { prototype: { spawn: (o: SpawnOpts) => unknown } };
  };

  const origConnect = net.Socket.prototype.connect;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (net.Socket.prototype as any).connect = function guardedConnect(
    this: net.Socket,
    ...args: unknown[]
  ) {
    const t = connectTarget(args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const connect = origConnect as any;
    if (t.ipc || isAllowed() !== null) return connect.apply(this, args);
    // A hostname with the caller's own resolver — the SSRF pinning tests point
    // `*.invalid` names at a loopback server. Judge the address it resolves to, not the
    // name, and do it BEFORE the loopback-name check: `localhost` (or no host) is
    // resolved through that same lookup and may be pinned anywhere.
    if (t.lookup && t.options && net.isIP(t.host ?? "") === 0) {
      const inner = t.lookup;
      const host = t.host ?? "localhost";
      const lookup = (hostname: string, lookupOpts: unknown, cb?: LookupCallback) => {
        const done = (typeof lookupOpts === "function" ? lookupOpts : cb) as LookupCallback;
        const call = (err: Error | null, address?: unknown, family?: number) => {
          const remote = err ? undefined : lookupAddresses(address).find((a) => !isLoopbackHost(a));
          if (remote !== undefined) {
            const msg = `unit test opened an outbound connection to ${host} → ${remote}`;
            record(msg);
            done(Object.assign(new Error(`${msg} (#1512 egress guard)`), { code: "ENETUNREACH" }));
            return;
          }
          done(err, address, family);
        };
        if (typeof lookupOpts === "function") {
          (inner as unknown as (h: string, c: LookupCallback) => void)(hostname, call);
        } else inner(hostname, lookupOpts, call);
      };
      return connect.call(this, { ...t.options, lookup }, t.callback);
    }
    if (isLoopbackHost(t.host)) return connect.apply(this, args);
    const msg = `unit test opened an outbound connection to ${t.host}`;
    record(msg);
    const err = Object.assign(new Error(`${msg} (#1512 egress guard)`), { code: "ENETUNREACH" });
    process.nextTick(() => this.destroy(err));
    return this;
  };

  const origSpawnSync = cp.spawnSync;
  const origExecFileSync = cp.execFileSync;
  const origExecSync = cp.execSync;

  // Reads `remote.*.url` / `submodule.*.url` through the ORIGINAL spawner (unguarded,
  // and a sync spawn never re-enters ChildProcess#spawn). Exit 1 = no match = none.
  const resolve: RemoteResolver = (git, globalArgs, cwd, kind) => {
    const read = (extra: string[]): string[] | null => {
      const r = origSpawnSync(
        git,
        [...globalArgs, "config", ...extra, "--get-regexp", `^${kind}\\..*\\.url$`],
        { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (r.error || (r.status !== 0 && r.status !== 1)) return null;
      return r.stdout.split("\n").filter((l) => l.trim() !== "");
    };
    const lines = read([]);
    if (lines === null) return null;
    if (kind === "submodule") {
      const fromFile = read(["-f", ".gitmodules"]);
      // No .gitmodules is exit 1 (empty), a malformed one is an error: fail closed.
      if (fromFile === null) return null;
      lines.push(...fromFile);
    }
    const names: string[] = [];
    const urls: string[] = [];
    for (const line of lines) {
      const sp = line.indexOf(" ");
      const key = sp === -1 ? line : line.slice(0, sp);
      names.push(key.slice(kind.length + 1, -".url".length));
      urls.push(sp === -1 ? "" : line.slice(sp + 1).trim());
    }
    return { names, urls };
  };

  type SpawnOpts = { file: string; args: string[]; cwd?: string };
  const proto = cp.ChildProcess.prototype;
  const origSpawn = proto.spawn;
  const refusesSpawn = (file: string, argv: readonly string[], cwd: string | undefined) => {
    const shellLine = shellLineOf(file, argv);
    return shellLine !== null
      ? isRemoteGitCommand(shellLine, { cwd, resolve })
      : isRemoteGitInvocation(file, argv, { cwd, resolve });
  };
  proto.spawn = function guardedSpawn(this: unknown, options: SpawnOpts) {
    const argv = (options?.args ?? []).slice(1);
    if (options && refusesSpawn(options.file, argv, options.cwd) && isAllowed() === null) {
      record(`unit test spawned a remote git: ${argv.join(" ")}`);
      options = { ...options, file: process.execPath, args: [process.execPath, ...BLOCKED_ARGS] };
    }
    return origSpawn.call(this, options);
  };

  const cwdOf = (o: unknown) =>
    o && typeof o === "object" && typeof (o as { cwd?: unknown }).cwd === "string"
      ? ((o as { cwd: string }).cwd as string)
      : undefined;
  const wrapFileSync = <F extends (...a: never[]) => unknown>(orig: F): F =>
    function guardedFileSync(this: unknown, file: string, args?: unknown, ...rest: unknown[]) {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      const options = Array.isArray(args) ? rest[0] : args;
      if (refusesSpawn(file, argv, cwdOf(options)) && isAllowed() === null) {
        record(`unit test spawned a remote git: ${argv.join(" ")}`);
        const opts = Array.isArray(args) ? rest : [args, ...rest];
        return (orig as unknown as (...a: unknown[]) => unknown).call(
          this,
          process.execPath,
          BLOCKED_ARGS,
          ...opts,
        );
      }
      return (orig as unknown as (...a: unknown[]) => unknown).call(this, file, args, ...rest);
    } as unknown as F;
  cp.spawnSync = wrapFileSync(origSpawnSync);
  cp.execFileSync = wrapFileSync(origExecFileSync);
  cp.execSync = function guardedExecSync(this: unknown, command: string, options?: unknown) {
    if (
      typeof command === "string" &&
      isRemoteGitCommand(command, { cwd: cwdOf(options), resolve }) &&
      isAllowed() === null
    ) {
      record(`unit test spawned a remote git: ${command}`);
      // No shell: run the stand-in directly, with the caller's options.
      return origExecFileSync(process.execPath, BLOCKED_ARGS, options as never);
    }
    return (origExecSync as unknown as (...a: unknown[]) => unknown).call(this, command, options);
  } as typeof cp.execSync;
  syncBuiltinESMExports();

  return {
    drain: () => violations.splice(0),
    uninstall() {
      net.Socket.prototype.connect = origConnect;
      proto.spawn = origSpawn;
      cp.spawnSync = origSpawnSync;
      cp.execFileSync = origExecFileSync;
      cp.execSync = origExecSync;
      syncBuiltinESMExports();
    },
  };
}
