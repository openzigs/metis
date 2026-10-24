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
 *   invocation naming a remote (non-loopback) URL is refused.
 *
 * A refused connection fails like a real one (an `ENETUNREACH` socket error, or a git
 * that exits 128), so the code under test sees an ordinary network failure. Because that
 * code may swallow the failure, every refusal is ALSO recorded, and the setup file fails
 * the test in `afterEach`/`afterAll` — the refusal cannot be caught away.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as ChildProcessModule from "node:child_process";
import net from "node:net";
import path from "node:path";

const require = createRequire(import.meta.url);

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

/** The host a git remote argument names, or null when the argument is not a remote. */
export function remoteHostOf(arg: string): string | null {
  const url = /^(?:https?|git|ssh|ftps?):\/\//i.test(arg) ? safeUrl(arg) : null;
  if (url) return url.hostname;
  // scp-like syntax: user@host:path
  const scp = /^[\w.-]+@([\w.-]+):/.exec(arg);
  return scp ? scp[1] : null;
}

function safeUrl(s: string): URL | null {
  try {
    return new URL(s);
  } catch {
    return null;
  }
}

/** True when `file args` is a git invocation that names a non-loopback remote. */
export function isRemoteGitInvocation(file: string, args: readonly string[]): boolean {
  const base = path.basename(file).toLowerCase();
  if (base !== "git" && base !== "git.exe") return false;
  return args.some((a) => {
    const host = remoteHostOf(a);
    return host !== null && !isLoopbackHost(host);
  });
}

/** True when a shell command line runs git against a non-loopback remote. */
export function isRemoteGitCommand(command: string): boolean {
  if (!/(^|[\s;&|/])git(\.exe)?\s/i.test(command)) return false;
  return command
    .split(/\s+/)
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    .some((t) => {
      const host = remoteHostOf(t);
      return host !== null && !isLoopbackHost(host);
    });
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

const BLOCKED_GIT_ARGS = ["-e", "process.exit(128)"];

/**
 * Install both hooks. `isAllowed` is consulted on every attempt: return a reason string
 * to let it through (an allowlisted suite), or null to refuse and record it.
 */
export function installEgressGuard(isAllowed: () => string | null = () => null): EgressGuard {
  const violations: string[] = [];
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
    if (t.ipc || isLoopbackHost(t.host) || isAllowed() !== null) return connect.apply(this, args);
    // A hostname with the caller's own resolver — the SSRF pinning tests point
    // `*.invalid` names at a loopback server. Judge the address it resolves to, not
    // the name. Without a custom resolver the name would go to real DNS: refuse it.
    if (t.lookup && t.options && net.isIP(t.host ?? "") === 0) {
      const inner = t.lookup;
      const host = t.host;
      const lookup = (hostname: string, opts: unknown, cb?: LookupCallback) => {
        const done = (typeof opts === "function" ? opts : cb) as LookupCallback;
        const call = (err: Error | null, address?: unknown, family?: number) => {
          const remote = err ? undefined : lookupAddresses(address).find((a) => !isLoopbackHost(a));
          if (remote !== undefined) {
            const msg = `unit test opened an outbound connection to ${host} → ${remote} (#1512 egress guard)`;
            violations.push(msg);
            done(Object.assign(new Error(msg), { code: "ENETUNREACH" }));
            return;
          }
          done(err, address, family);
        };
        if (typeof opts === "function")
          (inner as unknown as (h: string, c: LookupCallback) => void)(hostname, call);
        else inner(hostname, opts, call);
      };
      return connect.call(this, { ...t.options, lookup }, t.callback);
    }
    const msg = `unit test opened an outbound connection to ${t.host} (#1512 egress guard)`;
    violations.push(msg);
    const err = Object.assign(new Error(msg), { code: "ENETUNREACH" });
    process.nextTick(() => this.destroy(err));
    return this;
  };

  type SpawnOpts = { file: string; args: string[] };
  const proto = cp.ChildProcess.prototype;
  const origSpawn = proto.spawn;
  proto.spawn = function guardedSpawn(this: unknown, options: SpawnOpts) {
    const argv = (options?.args ?? []).slice(1);
    // `shell: true` / `exec()` arrive as `/bin/sh -c "<command line>"`.
    const shellLine = argv.length === 2 && /^[-/]c$/i.test(argv[0]) ? argv[1] : null;
    if (
      options &&
      (isRemoteGitInvocation(options.file, argv) ||
        (shellLine !== null && isRemoteGitCommand(shellLine))) &&
      isAllowed() === null
    ) {
      violations.push(
        `unit test spawned a remote git: ${options.args.slice(1).join(" ")} (#1512 egress guard)`,
      );
      options = {
        ...options,
        file: process.execPath,
        args: [process.execPath, ...BLOCKED_GIT_ARGS],
      };
    }
    return origSpawn.call(this, options);
  };

  const origSpawnSync = cp.spawnSync;
  const origExecFileSync = cp.execFileSync;
  const origExecSync = cp.execSync;
  const wrapFileSync = <F extends (...a: never[]) => unknown>(orig: F): F =>
    function guardedFileSync(this: unknown, file: string, args?: unknown, ...rest: unknown[]) {
      const argv = Array.isArray(args) ? (args as string[]) : [];
      if (isRemoteGitInvocation(file, argv) && isAllowed() === null) {
        violations.push(`unit test spawned a remote git: ${argv.join(" ")} (#1512 egress guard)`);
        const opts = Array.isArray(args) ? rest : [args, ...rest];
        return (orig as unknown as (...a: unknown[]) => unknown).call(
          this,
          process.execPath,
          BLOCKED_GIT_ARGS,
          ...opts,
        );
      }
      return (orig as unknown as (...a: unknown[]) => unknown).call(this, file, args, ...rest);
    } as unknown as F;
  cp.spawnSync = wrapFileSync(origSpawnSync);
  cp.execFileSync = wrapFileSync(origExecFileSync);
  cp.execSync = function guardedExecSync(this: unknown, command: string, ...rest: unknown[]) {
    if (typeof command === "string" && isRemoteGitCommand(command) && isAllowed() === null) {
      violations.push(`unit test spawned a remote git: ${command} (#1512 egress guard)`);
      command = `${JSON.stringify(process.execPath)} -e "process.exit(128)"`;
    }
    return (origExecSync as unknown as (...a: unknown[]) => unknown).call(this, command, ...rest);
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
