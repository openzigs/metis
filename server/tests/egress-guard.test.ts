/**
 * #1512 — the unit suite's egress guard (`helpers/egress-guard.ts`, installed by
 * `setup-egress-guard.ts`). These exercise the guard the setup file installed in this very
 * worker, then drain what it recorded so its `afterEach` does not fail this file.
 */
import { exec, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_EGRESS_GUARD,
  connectTarget,
  installEgressGuard,
  isLoopbackHost,
  isRemoteGitCommand,
  isRemoteGitInvocation,
  lookupAddresses,
  remoteHostOf,
  type EgressGuard,
} from "./helpers/egress-guard.js";

const active = () =>
  (globalThis as Record<symbol, unknown>)[ACTIVE_EGRESS_GUARD] as EgressGuard | undefined;

// TEST-NET-3 (RFC 5737): never routable, so a guard regression cannot reach anything.
const REMOTE_IP = "203.0.113.7";

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
    "github.com",
    "10.0.0.1",
    "192.168.1.1",
    "128.0.0.1",
    "::ffff:10.0.0.1",
    "localhost.evil.com",
  ])("treats %s as remote", (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

describe("remoteHostOf / isRemoteGitInvocation / isRemoteGitCommand", () => {
  it("extracts the host of URL and scp-style remotes", () => {
    expect(remoteHostOf("https://github.com/octocat/demo.git")).toBe("github.com");
    expect(remoteHostOf("ssh://git@ghe.example.com/x.git")).toBe("ghe.example.com");
    expect(remoteHostOf("git@github.com:octocat/demo.git")).toBe("github.com");
    expect(remoteHostOf("https://")).toBeNull();
    expect(remoteHostOf("--depth=1")).toBeNull();
    expect(remoteHostOf("/tmp/repo")).toBeNull();
    expect(remoteHostOf("file:///tmp/repo")).toBeNull();
  });

  it("flags git naming a remote, and nothing else", () => {
    expect(isRemoteGitInvocation("git", ["clone", "https://github.com/o/r.git", "/t"])).toBe(true);
    expect(isRemoteGitInvocation("/usr/bin/git", ["fetch", "git@github.com:o/r.git"])).toBe(true);
    expect(isRemoteGitInvocation("git.exe", ["ls-remote", "https://x.example/r"])).toBe(true);
    expect(isRemoteGitInvocation("git", ["clone", "http://127.0.0.1:9/r.git", "/t"])).toBe(false);
    expect(isRemoteGitInvocation("git", ["clone", "/tmp/src", "/tmp/dst"])).toBe(false);
    expect(isRemoteGitInvocation("git", ["clone", "file:///tmp/src", "/tmp/dst"])).toBe(false);
    expect(isRemoteGitInvocation("curl", ["https://github.com"])).toBe(false);
  });

  it("parses a shell command line", () => {
    expect(isRemoteGitCommand("git clone https://github.com/o/r.git /t")).toBe(true);
    expect(isRemoteGitCommand("cd /x && git fetch 'https://github.com/o/r'")).toBe(true);
    expect(isRemoteGitCommand("git clone /tmp/a /tmp/b")).toBe(false);
    expect(isRemoteGitCommand("curl https://github.com")).toBe(false);
  });
});

describe("connectTarget", () => {
  it("normalizes every Socket#connect call shape", () => {
    const cb = () => {};
    const lookup = () => {};
    expect(connectTarget([{ host: "a.example", port: 1 }])).toMatchObject({
      host: "a.example",
      ipc: false,
      lookup: undefined,
    });
    expect(connectTarget([[{ host: "b.example", port: 1, lookup }, cb]])).toMatchObject({
      host: "b.example",
      ipc: false,
      lookup,
      callback: cb,
    });
    expect(connectTarget([80, "c.example"])).toEqual({ host: "c.example", ipc: false });
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
      expect(active()!.drain()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("is refused when it resolves to a remote address", async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const s = net.connect({
        host: "evil.invalid",
        port: 80,
        lookup: pinnedTo(REMOTE_IP) as never,
      });
      s.on("error", resolve);
      s.on("connect", () => resolve(Object.assign(new Error("connected"), { code: "OK" })));
    });
    expect(err.code).toBe("ENETUNREACH");
    expect(active()!.drain()).toEqual([
      `unit test opened an outbound connection to evil.invalid → ${REMOTE_IP} (#1512 egress guard)`,
    ]);
  });

  it("passes a resolver error through unchanged", async () => {
    const failing = (_h: string, opts: unknown, cb?: Cb) =>
      ((typeof opts === "function" ? opts : cb) as Cb)(
        Object.assign(new Error("nope"), { code: "ENOTFOUND" }),
      );
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      net
        .connect({ host: "gone.invalid", port: 80, lookup: failing as never })
        .on("error", resolve);
    });
    expect(err.code).toBe("ENOTFOUND");
    expect(active()!.drain()).toEqual([]);
  });

  it("refuses a hostname with no custom resolver without querying DNS", async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      net.connect({ host: "github.com", port: 443 }).on("error", resolve);
    });
    expect(err.code).toBe("ENETUNREACH");
    expect(active()!.drain()).toEqual([
      "unit test opened an outbound connection to github.com (#1512 egress guard)",
    ]);
  });
});

describe.skipIf(GUARD_OFF)("the installed guard (server-unit)", () => {
  it("is installed in the default unit suite", () => {
    expect(process.env.RUN_INTEGRATION_TESTS).toBeFalsy();
    expect(active()).toBeDefined();
  });

  it("refuses an outbound socket with ENETUNREACH and records it", async () => {
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      const s = net.connect({ host: REMOTE_IP, port: 443 });
      s.on("error", resolve);
      s.on("connect", () => resolve(Object.assign(new Error("connected"), { code: "OK" })));
    });
    expect(err.code).toBe("ENETUNREACH");
    expect(active()!.drain()).toEqual([
      `unit test opened an outbound connection to ${REMOTE_IP} (#1512 egress guard)`,
    ]);
  });

  it("refuses fetch() to a remote host", async () => {
    await expect(fetch(`http://${REMOTE_IP}/`)).rejects.toThrow();
    expect(active()!.drain().join("\n")).toContain(REMOTE_IP);
  });

  it("lets a loopback server through untouched", async () => {
    const server = http.createServer((_req, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const { port } = server.address() as AddressInfo;
      const body = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(body).toBe("ok");
      expect(active()!.drain()).toEqual([]);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it("turns an async remote git clone into a git-style exit 128", async () => {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn("git", [
        "clone",
        "--depth=1",
        "https://github.com/octocat/demo.git",
        "/nonexistent/x",
      ]);
      child.on("close", resolve);
    });
    expect(code).toBe(128);
    expect(active()!.drain()[0]).toContain("clone --depth=1 https://github.com/octocat/demo.git");
  });

  it("guards a shell command line (exec / shell: true)", async () => {
    const code = await new Promise<number | null>((resolve) => {
      exec("git clone https://github.com/o/r.git /nonexistent/x").on("close", resolve);
    });
    expect(code).toBe(128);
    expect(active()!.drain()[0]).toContain("git clone https://github.com/o/r.git");
  });

  it("guards the sync spawners too", () => {
    expect(spawnSync("git", ["clone", "https://github.com/o/r.git", "/nonexistent/x"]).status).toBe(
      128,
    );
    expect(() =>
      execFileSync("git", ["fetch", "git@github.com:o/r.git"], { stdio: "ignore" }),
    ).toThrow();
    expect(() =>
      execSync("git clone https://github.com/o/r.git /nonexistent/x", { stdio: "ignore" }),
    ).toThrow();
    expect(active()!.drain()).toHaveLength(3);
  });

  it("passes a non-git or local spawn through", () => {
    const out = spawnSync(process.execPath, ["-e", "process.stdout.write('hi')"]);
    expect(out.stdout.toString()).toBe("hi");
    expect(execFileSync(process.execPath, ["-e", "process.stdout.write('yo')"]).toString()).toBe(
      "yo",
    );
    expect(
      execSync(`${JSON.stringify(process.execPath)} -e "process.stdout.write('x')"`).toString(),
    ).toBe("x");
    expect(active()!.drain()).toEqual([]);
  });
});

describe.skipIf(GUARD_OFF)("installEgressGuard", () => {
  it("lets an allowlisted suite through, and uninstall restores the hooks", async () => {
    const before = net.Socket.prototype.connect;
    const inner = installEgressGuard(() => "allowlisted for this test");
    expect(net.Socket.prototype.connect).not.toBe(before);
    // The inner guard allows it, so the call reaches the outer (setup) guard, which
    // is what refuses it here — proof the inner one let it through.
    const status = spawnSync("git", [
      "clone",
      "https://github.com/o/r.git",
      "/nonexistent/x",
    ]).status;
    expect(status).toBe(128);
    expect(inner.drain()).toEqual([]);
    expect(active()!.drain()).toHaveLength(1);
    inner.uninstall();
    expect(net.Socket.prototype.connect).toBe(before);
  });

  it("refuses with its own record when nothing is allowed", () => {
    const inner = installEgressGuard();
    try {
      expect(spawnSync("git", ["ls-remote", "https://github.com/o/r.git"]).status).toBe(128);
      expect(inner.drain()).toHaveLength(1);
      expect(active()!.drain()).toEqual([]);
    } finally {
      inner.uninstall();
    }
  });
});
