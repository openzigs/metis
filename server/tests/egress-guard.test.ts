/**
 * #1512 — the unit suite's egress guard (`helpers/egress-guard.ts`, installed by
 * `setup-egress-guard.ts`). These exercise the guard the setup file installed in this very
 * worker, then drain what it recorded so its `afterEach` does not fail this file.
 *
 * Every remote here is TEST-NET-3 (RFC 5737, never routable) or a `.invalid` name (RFC
 * 6761, never resolves), so a regressed hook cannot make this suite egress. A refused git
 * is told apart from a real git failure by the guard's own record and BLOCKED_MARKER on
 * stderr, never by exit code 128 alone (real git exits 128 too).
 */
import { exec, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import nodePath from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ACTIVE_EGRESS_GUARD,
  BLOCKED_MARKER,
  connectTarget,
  installEgressGuard,
  isLocalRepo,
  isLoopbackHost,
  isRemoteGitCommand,
  isRemoteGitInvocation,
  lookupAddresses,
  parseGitArgs,
  remoteHostOf,
  shellCommands,
  shellLineOf,
  type ConfiguredRemotes,
  type EgressGuard,
  type RemoteResolver,
} from "./helpers/egress-guard.js";

const active = () =>
  (globalThis as Record<symbol, unknown>)[ACTIVE_EGRESS_GUARD] as EgressGuard | undefined;

const REMOTE_IP = "203.0.113.7";
const REMOTE_URL = `https://${REMOTE_IP}/o/r.git`;
const REMOTE_SCP = `git@${REMOTE_IP}:o/r.git`;

// `postgres-unit` runs this config with RUN_INTEGRATION_TESTS set, where the setup file
// stands the guard down; the blocks that exercise the installed guard skip there.
const GUARD_OFF = Boolean(process.env.RUN_INTEGRATION_TESTS);

describe.runIf(GUARD_OFF)("with RUN_INTEGRATION_TESTS set (postgres-unit)", () => {
  it("installs no guard", () => {
    expect(active()).toBeUndefined();
  });
});

afterEach(() => {
  active()?.drain();
});

describe("isLoopbackHost", () => {
  it.each([
    undefined,
    null,
    "",
    "localhost",
    "LOCALHOST",
    "api.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "::1",
    "[::1]",
    "::",
    "0.0.0.0",
    "::ffff:127.0.0.1",
    "0:0:0:0:0:0:0:1",
  ])("treats %s as loopback", (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each([
    "remote.invalid",
    "10.0.0.1",
    "192.168.1.1",
    "128.0.0.1",
    "::ffff:10.0.0.1",
    "localhost.evil.invalid",
  ])("treats %s as remote", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("remoteHostOf / isLocalRepo", () => {
  it("reads URL and scp forms, with and without a user", () => {
    expect(remoteHostOf(REMOTE_URL)).toBe(REMOTE_IP);
    expect(remoteHostOf("ssh://git@ghe.example.invalid/x.git")).toBe("ghe.example.invalid");
    expect(remoteHostOf(REMOTE_SCP)).toBe(REMOTE_IP);
    expect(remoteHostOf("host.example.invalid:o/r.git")).toBe("host.example.invalid");
    expect(remoteHostOf("host.example.invalid:o/r.git", { bare: false })).toBeNull();
  });

  it("does not read paths, drives, refspecs or file:// as hosts", () => {
    for (const a of [
      "https://",
      "--depth=1",
      "/tmp/repo",
      "file:///tmp/repo",
      "C:\\repo",
      "main:main",
    ]) {
      expect(remoteHostOf(a)).toBeNull();
    }
  });

  it("treats paths, file:// and loopback URLs as local", () => {
    expect(isLocalRepo("/tmp/repo")).toBe(true);
    expect(isLocalRepo("file:///tmp/repo")).toBe(true);
    expect(isLocalRepo("http://127.0.0.1:9/r.git")).toBe(true);
    expect(isLocalRepo(REMOTE_URL)).toBe(false);
  });
});

describe("parseGitArgs", () => {
  it("separates global options from the subcommand", () => {
    expect(parseGitArgs(["-C", "/x", "-c", "a=b", "--no-pager", "fetch", "origin"])).toEqual({
      globalArgs: ["-C", "/x", "-c", "a=b", "--no-pager"],
      subcommand: "fetch",
      rest: ["origin"],
    });
    expect(parseGitArgs(["--version"])).toEqual({
      globalArgs: ["--version"],
      subcommand: null,
      rest: [],
    });
  });
});

describe("isRemoteGitInvocation", () => {
  const remotes =
    (r: ConfiguredRemotes | null): RemoteResolver =>
    () =>
      r;
  const remoteOrigin = remotes({ names: ["origin"], urls: [REMOTE_URL] });
  const localOrigin = remotes({ names: ["origin"], urls: ["/tmp/src"] });

  it("flags an explicit remote anywhere, and only for git", () => {
    expect(isRemoteGitInvocation("git", ["clone", REMOTE_URL, "/t"])).toBe(true);
    expect(isRemoteGitInvocation("/usr/bin/git", ["fetch", REMOTE_SCP])).toBe(true);
    expect(isRemoteGitInvocation("git.exe", ["ls-remote", REMOTE_URL])).toBe(true);
    expect(isRemoteGitInvocation('"/usr/bin/git"', ["clone", REMOTE_URL])).toBe(true);
    expect(isRemoteGitInvocation("git", ["clone", "host.example.invalid:o/r", "/t"])).toBe(true);
    expect(isRemoteGitInvocation("git", ["archive", `--remote=${REMOTE_URL}`, "HEAD"])).toBe(true);
    expect(
      isRemoteGitInvocation("C:\\Program Files\\Git\\bin\\git.exe", ["fetch", REMOTE_URL]),
    ).toBe(true);
    expect(isRemoteGitInvocation("curl", [REMOTE_URL])).toBe(false);
  });

  it("passes local clones and non-network subcommands", () => {
    expect(isRemoteGitInvocation("git", ["clone", "http://127.0.0.1:9/r.git", "/t"])).toBe(false);
    expect(isRemoteGitInvocation("git", ["clone", "/tmp/src", "/tmp/dst"])).toBe(false);
    expect(isRemoteGitInvocation("git", ["clone", "file:///tmp/src", "/tmp/dst"])).toBe(false);
    expect(isRemoteGitInvocation("git", ["show", "v1.2:path/file"])).toBe(false);
    // Writing a URL into config reaches nothing.
    expect(isRemoteGitInvocation("git", ["remote", "add", "origin", REMOTE_URL])).toBe(false);
    expect(isRemoteGitInvocation("git", ["remote", "set-url", "origin", REMOTE_URL])).toBe(false);
    expect(isRemoteGitInvocation("git", ["config", "remote.origin.url", REMOTE_URL])).toBe(false);
    expect(isRemoteGitInvocation("git", ["status"], { resolve: remoteOrigin })).toBe(false);
    expect(isRemoteGitInvocation("git", ["remote", "-v"], { resolve: remoteOrigin })).toBe(false);
    expect(isRemoteGitInvocation("git", ["submodule", "status"], { resolve: remoteOrigin })).toBe(
      false,
    );
  });

  it.each([
    [["pull", "origin", "main", "--ff-only"]],
    [["fetch"]],
    [["fetch", "origin"]],
    [["push", "origin", "main:main"]],
    [["ls-remote", "origin"]],
    [["-C", "/repo", "fetch", "origin"]],
    [["remote", "update"]],
    [["remote", "show", "origin"]],
  ])("flags git %j when the configured remote is not local", (args) => {
    expect(isRemoteGitInvocation("git", args, { resolve: remoteOrigin })).toBe(true);
    expect(isRemoteGitInvocation("git", args, { resolve: localOrigin })).toBe(false);
  });

  it("judges submodule update by the submodule URLs", () => {
    const sub = (url: string) => remotes({ names: ["lib"], urls: [url] });
    expect(
      isRemoteGitInvocation("git", ["submodule", "update", "--init"], { resolve: sub(REMOTE_URL) }),
    ).toBe(true);
    expect(isRemoteGitInvocation("git", ["submodule", "update"], { resolve: sub("../lib") })).toBe(
      false,
    );
    expect(isRemoteGitInvocation("git", ["submodule", "add", REMOTE_URL, "lib"])).toBe(true);
  });

  it("lets an explicit local path through even when origin is remote", () => {
    expect(
      isRemoteGitInvocation("git", ["fetch", "/tmp/src", "main"], { resolve: remoteOrigin }),
    ).toBe(false);
    expect(
      isRemoteGitInvocation("git", ["fetch", "file:///tmp/src"], { resolve: remoteOrigin }),
    ).toBe(false);
  });

  it("fails closed when the remotes cannot be resolved", () => {
    expect(isRemoteGitInvocation("git", ["fetch", "origin"])).toBe(true);
    expect(isRemoteGitInvocation("git", ["fetch", "origin"], { resolve: remotes(null) })).toBe(
      true,
    );
  });
});

describe("shell command lines", () => {
  it("splits and unquotes simple commands", () => {
    expect(shellCommands(`cd /x && "/usr/bin/git" clone '${REMOTE_URL}' ; echo ok`)).toEqual([
      ["cd", "/x"],
      ["/usr/bin/git", "clone", REMOTE_URL],
      ["echo", "ok"],
    ]);
  });

  it("finds a remote git in a command line", () => {
    expect(isRemoteGitCommand(`git clone ${REMOTE_URL} /t`)).toBe(true);
    expect(isRemoteGitCommand(`cd /x && "/usr/bin/git" fetch '${REMOTE_URL}'`)).toBe(true);
    expect(isRemoteGitCommand("git clone /tmp/a /tmp/b")).toBe(false);
    expect(isRemoteGitCommand(`curl ${REMOTE_URL}`)).toBe(false);
  });

  it("extracts the line from sh -c and cmd.exe /d /s /c", () => {
    expect(shellLineOf("/bin/sh", ["-c", "git status"])).toBe("git status");
    expect(shellLineOf("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", '"git status"'])).toBe(
      '"git status"',
    );
    expect(shellLineOf("/bin/sh", ["-c"])).toBeNull();
    expect(shellLineOf("/usr/bin/git", ["-c", "a=b"])).toBeNull();
  });
});

describe("connectTarget", () => {
  it("normalizes every Socket#connect call shape", () => {
    const cb = () => {};
    const lookup = () => {};
    expect(connectTarget([{ host: "a.invalid", port: 1 }])).toMatchObject({
      host: "a.invalid",
      ipc: false,
      lookup: undefined,
    });
    expect(connectTarget([[{ host: "b.invalid", port: 1, lookup }, cb]])).toMatchObject({
      host: "b.invalid",
      ipc: false,
      lookup,
      callback: cb,
    });
    expect(connectTarget([80, "c.invalid"])).toEqual({ host: "c.invalid", ipc: false });
    expect(connectTarget([80])).toEqual({ host: undefined, ipc: false });
    expect(connectTarget(["/tmp/sock"])).toEqual({ host: undefined, ipc: true });
    expect(connectTarget([{ path: "/tmp/sock" }])).toEqual({ host: undefined, ipc: true });
    expect(connectTarget([])).toEqual({ host: undefined, ipc: false });
  });
});

describe("lookupAddresses", () => {
  it("reads the single and the all:true lookup results", () => {
    expect(lookupAddresses("127.0.0.1")).toEqual(["127.0.0.1"]);
    expect(lookupAddresses([{ address: "::1", family: 6 }, { address: "10.0.0.1" }])).toEqual([
      "::1",
      "10.0.0.1",
    ]);
    expect(lookupAddresses(undefined)).toEqual([]);
  });
});

/** The guard's records since the last drain, joined. */
const drained = () => active()!.drain().join("\n");

describe.skipIf(GUARD_OFF)("a hostname with the caller's own (pinned) resolver", () => {
  type Cb = (err: Error | null, address?: unknown, family?: number) => void;
  const pinnedTo =
    (address: string) =>
    (_h: string, opts: unknown, cb?: Cb): void => {
      const done = (typeof opts === "function" ? opts : cb) as Cb;
      if (opts && typeof opts === "object" && (opts as { all?: boolean }).all) {
        done(null, [{ address, family: net.isIP(address) }]);
      } else done(null, address, net.isIP(address));
    };
  const connectError = (opts: net.NetConnectOpts) =>
    new Promise<NodeJS.ErrnoException>((resolve) => {
      const s = net.connect(opts);
      s.on("error", resolve);
      s.on("connect", () => {
        s.destroy();
        resolve(Object.assign(new Error("connected"), { code: "CONNECTED" }));
      });
    });

  it("is allowed when it resolves to loopback (the SSRF pinning tests)", async () => {
    const server = http.createServer((_req, res) => res.end("pinned"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await new Promise<string>((resolve, reject) => {
        http
          .get(
            { host: "pinned.metis.invalid", port, lookup: pinnedTo("127.0.0.1") as never },
            (res) => {
              let b = "";
              res.on("data", (c) => (b += c));
              res.on("end", () => resolve(b));
            },
          )
          .on("error", reject);
      });
      expect(body).toBe("pinned");
      expect(drained()).toBe("");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("is refused when it resolves to a remote address", async () => {
    const err = await connectError({
      host: "evil.invalid",
      port: 80,
      lookup: pinnedTo(REMOTE_IP) as never,
    });
    expect(err.code).toBe("ENETUNREACH");
    expect(drained()).toContain(`outbound connection to evil.invalid → ${REMOTE_IP}`);
  });

  it("judges the lookup even for a loopback name, or no host at all", async () => {
    for (const host of ["localhost", undefined]) {
      const err = await connectError({ host, port: 80, lookup: pinnedTo(REMOTE_IP) as never });
      expect(err.code).toBe("ENETUNREACH");
      expect(drained()).toContain(`outbound connection to localhost → ${REMOTE_IP}`);
    }
  });

  it("passes a resolver error through unchanged", async () => {
    const failing = (_h: string, opts: unknown, cb?: Cb) =>
      ((typeof opts === "function" ? opts : cb) as Cb)(
        Object.assign(new Error("nope"), { code: "ENOTFOUND" }),
      );
    const err = await connectError({ host: "gone.invalid", port: 80, lookup: failing as never });
    expect(err.code).toBe("ENOTFOUND");
    expect(drained()).toBe("");
  });

  it("refuses a hostname with no custom resolver without querying DNS", async () => {
    const err = await connectError({ host: "egress-test.invalid", port: 443 });
    expect(err.code).toBe("ENETUNREACH");
    expect(drained()).toContain("outbound connection to egress-test.invalid");
  });
});

describe.skipIf(GUARD_OFF)("the installed guard (server-unit)", () => {
  it("is installed in the default unit suite", () => {
    expect(process.env.RUN_INTEGRATION_TESTS).toBeFalsy();
    expect(active()).toBeDefined();
  });

  it("refuses an outbound socket with ENETUNREACH and names the running test", async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      net.connect({ host: REMOTE_IP, port: 443 }).on("error", resolve);
    });
    expect(err.code).toBe("ENETUNREACH");
    const rec = drained();
    expect(rec).toContain(`outbound connection to ${REMOTE_IP}`);
    expect(rec).toContain(
      "[during: the installed guard (server-unit) > refuses an outbound socket",
    );
  });

  it("refuses fetch() to a remote host", async () => {
    await expect(fetch(`http://${REMOTE_IP}/`)).rejects.toThrow();
    expect(drained()).toContain(REMOTE_IP);
  });

  it("lets a loopback server through untouched", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(body).toBe("ok");
      expect(drained()).toBe("");
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("swaps an async remote git for the stand-in", async () => {
    const stderr = await new Promise<string>((resolve) => {
      const child = spawn("git", ["clone", "--depth=1", REMOTE_URL, "/nonexistent/x"]);
      let e = "";
      child.stderr.on("data", (c) => (e += c));
      child.on("close", () => resolve(e));
    });
    expect(stderr).toContain(BLOCKED_MARKER);
    expect(drained()).toContain(`spawned a remote git: clone --depth=1 ${REMOTE_URL}`);
  });

  it("guards a shell command line (exec / shell: true)", async () => {
    const stderr = await new Promise<string>((resolve) => {
      exec(`git clone ${REMOTE_URL} /nonexistent/x`, (_err, _out, e) => resolve(e));
    });
    expect(stderr).toContain(BLOCKED_MARKER);
    expect(drained()).toContain(`git clone ${REMOTE_URL}`);
  });

  it("guards the sync spawners too", () => {
    const r = spawnSync("git", ["clone", REMOTE_URL, "/nonexistent/x"], { encoding: "utf8" });
    expect(r.stderr).toContain(BLOCKED_MARKER);
    expect(() => execFileSync("git", ["fetch", REMOTE_SCP], { stdio: "pipe" })).toThrow(
      BLOCKED_MARKER,
    );
    expect(() => execSync(`git clone ${REMOTE_URL} /nonexistent/x`, { stdio: "pipe" })).toThrow(
      BLOCKED_MARKER,
    );
    expect(active()!.drain()).toHaveLength(3);
  });

  it("passes a non-git or local spawn through", () => {
    const out = spawnSync(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(out.stdout.toString()).toBe("hi");
    expect(execFileSync(process.execPath, ["-e", "process.stdout.write('yo')"]).toString()).toBe(
      "yo",
    );
    expect(execSync("echo x").toString().trim()).toBe("x");
    expect(drained()).toBe("");
  });
});

describe.skipIf(GUARD_OFF)("a git that names a configured remote (real repositories)", () => {
  let dir: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });

  beforeAll(() => {
    dir = mkdtempSync(nodePath.join(os.tmpdir(), "metis-1512-guard-"));
    for (const name of ["src", "remote-origin", "local-origin"]) {
      git(dir, "init", "-q", "-b", "main", name);
    }
    const src = nodePath.join(dir, "src");
    git(
      src,
      "-c",
      "user.email=t@t.invalid",
      "-c",
      "user.name=t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "c",
    );
    git(nodePath.join(dir, "remote-origin"), "remote", "add", "origin", REMOTE_URL);
    git(nodePath.join(dir, "local-origin"), "remote", "add", "origin", src);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("refuses `git fetch origin` / `git pull` when origin is remote", () => {
    const cwd = nodePath.join(dir, "remote-origin");
    for (const args of [["fetch", "origin"], ["pull", "origin", "main"], ["ls-remote"]]) {
      const r = spawnSync("git", args, { cwd, encoding: "utf8" });
      expect(r.stderr).toContain(BLOCKED_MARKER);
    }
    expect(active()!.drain()).toHaveLength(3);
  });

  it("refuses `git -C <repo> fetch` from elsewhere", () => {
    const r = spawnSync("git", ["-C", nodePath.join(dir, "remote-origin"), "fetch"], {
      cwd: os.tmpdir(),
      encoding: "utf8",
    });
    expect(r.stderr).toContain(BLOCKED_MARKER);
    expect(drained()).toContain("spawned a remote git: -C");
  });

  it("lets a fetch from a local origin run for real", () => {
    const r = spawnSync("git", ["fetch", "origin"], {
      cwd: nodePath.join(dir, "local-origin"),
      encoding: "utf8",
    });
    expect(r.stderr).not.toContain(BLOCKED_MARKER);
    expect(r.status).toBe(0);
    expect(drained()).toBe("");
  });

  it("refuses `git submodule update` when .gitmodules names a remote", () => {
    const cwd = nodePath.join(dir, "local-origin");
    git(cwd, "config", "-f", ".gitmodules", "submodule.lib.path", "lib");
    git(cwd, "config", "-f", ".gitmodules", "submodule.lib.url", REMOTE_URL);
    const r = spawnSync("git", ["submodule", "update", "--init"], { cwd, encoding: "utf8" });
    expect(r.stderr).toContain(BLOCKED_MARKER);
    expect(drained()).toContain("submodule update --init");
  });

  it("fails closed when the repository cannot be read", () => {
    const r = spawnSync("git", ["fetch", "origin"], {
      cwd: nodePath.join(dir, "does-not-exist"),
      encoding: "utf8",
    });
    // The stand-in never ran either (the cwd is missing), but the attempt is recorded.
    expect(r.stderr ?? "").not.toContain("Already up to date");
    expect(drained()).toContain("spawned a remote git: fetch origin");
  });
});

describe.skipIf(GUARD_OFF)("installEgressGuard", () => {
  it("lets an allowlisted suite through, and uninstall restores the hooks", () => {
    const before = net.Socket.prototype.connect;
    const inner = installEgressGuard({ isAllowed: () => "allowlisted for this test" });
    expect(net.Socket.prototype.connect).not.toBe(before);
    // The inner guard allows it, so the call reaches the outer (setup) guard, which
    // is what refuses it here — proof the inner one let it through.
    const r = spawnSync("git", ["clone", REMOTE_URL, "/nonexistent/x"], { encoding: "utf8" });
    expect(r.stderr).toContain(BLOCKED_MARKER);
    expect(inner.drain()).toEqual([]);
    expect(active()!.drain()).toHaveLength(1);
    inner.uninstall();
    expect(net.Socket.prototype.connect).toBe(before);
  });

  it("refuses with its own record when nothing is allowed", () => {
    const inner = installEgressGuard();
    try {
      const r = spawnSync("git", ["ls-remote", REMOTE_URL], { encoding: "utf8" });
      expect(r.stderr).toContain(BLOCKED_MARKER);
      expect(inner.drain()).toHaveLength(1);
      expect(active()!.drain()).toEqual([]);
    } finally {
      inner.uninstall();
    }
  });
});
