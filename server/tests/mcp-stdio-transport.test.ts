/**
 * Stdio transport — verify validateCommand security checks, JSON-RPC framing,
 * timeout handling, and graceful shutdown via an injected fake spawn.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MCPStdioTransport,
  validateCommand,
  inheritedEnv,
  INHERITED_ENV_KEYS,
} from "../src/lib/mcp/stdio-transport.js";

class FakeStream extends EventEmitter {
  written: string[] = [];
  setEncoding = vi.fn();
  write(chunk: string): boolean {
    this.written.push(chunk);
    return true;
  }
}

class FakeChild extends EventEmitter {
  stdin = new FakeStream();
  stdout = new FakeStream();
  stderr = new FakeStream();
  killed = false;
  exitCode: number | null = null;
  kill(signal?: string): boolean {
    this.killed = true;
    queueMicrotask(() => this.emit("exit", 0, signal ?? null));
    return true;
  }
}

describe("validateCommand", () => {
  it.each([
    ["empty", ""],
    ["null", null],
    ["semicolon", "rm; ls"],
    ["pipe", "cat | grep"],
    ["backtick", "echo `whoami`"],
    ["dollar", "echo $foo"],
    ["redirect", "cat < x"],
    ["newline", "ls\nrm"],
  ])("rejects %s", (_label, val) => {
    expect(() => validateCommand(val as string)).toThrow();
  });

  it("rejects commands over 512 chars", () => {
    expect(() => validateCommand("x".repeat(513))).toThrow();
  });

  it("accepts safe commands", () => {
    expect(() => validateCommand("npx")).not.toThrow();
    expect(() => validateCommand("/usr/local/bin/uvx")).not.toThrow();
  });
});

describe("MCPStdioTransport", () => {
  function setup() {
    const child = new FakeChild();
    const spawnFn = vi.fn(() => child as never);
    const t = new MCPStdioTransport({
      command: "node",
      args: ["script.js"],
      env: { FOO: "bar" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawnFn: spawnFn as any,
    });
    return { t, child, spawnFn };
  }

  it("spawns with shell:false and inherits PATH", async () => {
    const { t, spawnFn } = setup();
    await t.start();
    expect(spawnFn).toHaveBeenCalledWith(
      "node",
      ["script.js"],
      expect.objectContaining({ shell: false, stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("frames request -> response via stdout newline", async () => {
    const { t, child } = setup();
    await t.start();
    const p = t.request<{ ok: boolean }>("ping");
    // Pull written request and reply with matching id
    const written = child.stdin.written.shift()!;
    const msg = JSON.parse(written.trim());
    expect(msg).toMatchObject({ jsonrpc: "2.0", method: "ping" });
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { ok: true } })}\n`,
    );
    await expect(p).resolves.toEqual({ ok: true });
  });

  it("propagates JSON-RPC errors", async () => {
    const { t, child } = setup();
    await t.start();
    const p = t.request("tools/list");
    const id = JSON.parse(child.stdin.written[0].trim()).id;
    child.stdout.emit(
      "data",
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "boom" } })}\n`,
    );
    await expect(p).rejects.toThrow(/boom/);
  });

  it("times out a hung request", async () => {
    const { t } = setup();
    await t.start();
    await expect(t.request("ping", undefined, 10)).rejects.toThrow(/timed out/);
  });

  it("notify writes a frame without id", async () => {
    const { t, child } = setup();
    await t.start();
    await t.notify("notifications/initialized");
    expect(child.stdin.written[0]).toContain('"method":"notifications/initialized"');
    expect(child.stdin.written[0]).not.toContain('"id"');
  });

  it("fails pending requests when the child exits", async () => {
    const { t, child } = setup();
    await t.start();
    const p = t.request("ping");
    child.emit("exit", 1, null);
    await expect(p).rejects.toThrow(/MCP child exited/);
  });

  it("stop() sends SIGTERM then resolves closed()", async () => {
    const { t, child } = setup();
    await t.start();
    const closedP = t.closed();
    await t.stop("test");
    expect(child.killed).toBe(true);
    await expect(closedP).resolves.toBeDefined();
  });

  it("ignores non-JSON output", async () => {
    const { t, child } = setup();
    await t.start();
    // No throw
    child.stdout.emit("data", "garbage\n");
    expect(true).toBe(true);
  });
});

// SEC-4: stdio child must NOT inherit the full parent process env.
describe("MCPStdioTransport env inheritance (SEC-4)", () => {
  it("only forwards INHERITED_ENV_KEYS plus the configured env to the child", async () => {
    const original = { ...process.env };
    process.env.PATH = "/test/bin";
    process.env.HOME = "/tmp/test-home";
    process.env.LANG = "en_US.UTF-8";
    process.env.DOCKER_HOST = "unix:///var/run/docker.sock";
    process.env.DOCKER_API_VERSION = "1.41";
    process.env.DATABASE_URL = "postgres://leak/me";
    process.env.JWT_ACCESS_SECRET = "do-not-share";
    process.env.VAULT_MASTER_KEY = "absolutely-secret";
    process.env.OPENAI_API_KEY = "sk-shouldnt-leak";
    try {
      const child = new (class extends EventEmitter {
        stdin = new EventEmitter();
        stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
        stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
      })();
      let captured: Record<string, string | undefined> = {};
      const spawnFn = vi.fn(
        (_cmd: string, _args: string[], opts: { env: Record<string, string | undefined> }) => {
          captured = opts.env;
          return child as never;
        },
      );
      const t = new MCPStdioTransport({
        command: "node",
        args: ["x.js"],
        env: { CHILD_ONLY: "yes" },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawnFn: spawnFn as any,
      });
      await t.start();
      // Allow-listed
      expect(captured.PATH).toBe("/test/bin");
      expect(captured.HOME).toBe("/tmp/test-home");
      expect(captured.LANG).toBe("en_US.UTF-8");
      expect(captured.DOCKER_HOST).toBe("unix:///var/run/docker.sock");
      expect(captured.DOCKER_API_VERSION).toBe("1.41");
      expect(captured.CHILD_ONLY).toBe("yes");
      // NOT forwarded
      expect(captured.DATABASE_URL).toBeUndefined();
      expect(captured.JWT_ACCESS_SECRET).toBeUndefined();
      expect(captured.VAULT_MASTER_KEY).toBeUndefined();
      expect(captured.OPENAI_API_KEY).toBeUndefined();
    } finally {
      process.env = original;
    }
  });

  it("inheritedEnv() returns only the documented keys", () => {
    const original = { ...process.env };
    try {
      process.env.PATH = "/x";
      process.env.HOME = "/y";
      process.env.SOMETHING_ELSE = "secret";
      const env = inheritedEnv();
      for (const k of Object.keys(env)) {
        expect(INHERITED_ENV_KEYS).toContain(k as (typeof INHERITED_ENV_KEYS)[number]);
      }
      expect(env).not.toHaveProperty("SOMETHING_ELSE");
    } finally {
      process.env = original;
    }
  });
});
