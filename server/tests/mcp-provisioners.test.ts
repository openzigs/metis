/**
 * Epic #271 / Issue #280 — provisioner tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

// Mock child_process.spawn so we can exercise the default `docker rm -f`
// cleanup path without shelling out to a real docker daemon.
const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
}));

// Stub config-service before importing the SUT so getConfigService() returns
// a controllable in-memory store.
const cfgStore = new Map<string, string | null>();
vi.mock("../src/lib/config/config-service.js", () => {
  const cfg = {
    get(key: string): string | null {
      return cfgStore.get(key) ?? null;
    },
    getBool(_key: string, fallback: boolean): boolean {
      return fallback;
    },
    getNumber(_key: string, fallback: number): number {
      return fallback;
    },
  };
  return {
    getConfigService: () => cfg,
    __resetConfigSingleton: () => undefined,
    ConfigService: class {},
    CONFIG_KEYS: {},
  };
});

import {
  DockerStdioProvisioner,
  buildContainerName,
} from "../src/lib/mcp/provisioners/docker-stdio.js";
import { NativeProvisioner } from "../src/lib/mcp/provisioners/native.js";
import type { MCPServerConfig } from "../src/lib/mcp/types.js";

function baseConfig(over: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "srv-abc",
    scope: "global",
    projectId: null,
    label: "test",
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: ["index.js"],
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    healthCheckIntervalSec: 60,
    enabled: true,
    ...over,
  };
}

describe("NativeProvisioner", () => {
  it("returns command/args/env unchanged", async () => {
    const p = new NativeProvisioner();
    const out = await p.provision(baseConfig({ runtime: "native" }), { FOO: "bar" });
    expect(out.command).toBe("node");
    expect(out.args).toEqual(["index.js"]);
    expect(out.env).toEqual({ FOO: "bar" });
    expect(out.cleanup).toBeUndefined();
  });

  it("rejects when command is null", async () => {
    const p = new NativeProvisioner();
    await expect(p.provision(baseConfig({ runtime: "native", command: null }), {})).rejects.toThrow(
      /requires command/,
    );
  });

  it("clones args + env (no aliasing)", async () => {
    const p = new NativeProvisioner();
    const env = { FOO: "bar" };
    const cfg = baseConfig({ runtime: "native", args: ["a", "b"] });
    const out = await p.provision(cfg, env);
    out.args.push("mutated");
    out.env.NEW_KEY = "x";
    expect(cfg.args).toEqual(["a", "b"]);
    expect(env).toEqual({ FOO: "bar" });
  });
});

describe("DockerStdioProvisioner", () => {
  beforeEach(() => {
    cfgStore.clear();
    cfgStore.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/metis-mcps/*,ghcr.io/github/*");
  });

  afterEach(() => {
    cfgStore.clear();
  });

  it("builds a docker run -i --rm invocation with limits and -e KEY env", async () => {
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({
        runtime: "docker-stdio",
        command: "ghcr.io/metis-mcps/uvx-runner:1.0",
        args: ["mcp-atlassian"],
      }),
      { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_secret" },
    );
    expect(out.command).toBe("docker");
    expect(out.args[0]).toBe("run");
    expect(out.args).toContain("-i");
    expect(out.args).toContain("--rm");
    expect(out.args).toContain("--memory");
    expect(out.args).toContain("--cpus");
    expect(out.args).toContain("--network");
    expect(out.args).toContain("--tmpfs");
    expect(out.args).toContain("/workspace:rw,nosuid,nodev,size=64m");
    expect(out.args).toContain("ghcr.io/metis-mcps/uvx-runner:1.0");
    expect(out.args).toContain("mcp-atlassian");
    const eIdx = out.args.findIndex((a) => a === "-e");
    expect(out.args[eIdx + 1]).toBe("GITHUB_PERSONAL_ACCESS_TOKEN");
    expect(out.args[eIdx + 1]).not.toContain("=");
    expect(out.env.GITHUB_PERSONAL_ACCESS_TOKEN).toBe("ghp_secret");
    expect(typeof out.cleanup).toBe("function");
  });

  it("uses runtime tunables for memory/cpu/network", async () => {
    cfgStore.set("MCP_DOCKER_MEMORY_LIMIT", "256m");
    cfgStore.set("MCP_DOCKER_CPU_LIMIT", "0.5");
    cfgStore.set("MCP_DOCKER_NETWORK", "metis-mcp-test");
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({
        runtime: "docker-stdio",
        command: "ghcr.io/metis-mcps/uvx-runner:1.0",
        args: [],
      }),
      {},
    );
    const memIdx = out.args.indexOf("--memory");
    const cpuIdx = out.args.indexOf("--cpus");
    const netIdx = out.args.indexOf("--network");
    expect(out.args[memIdx + 1]).toBe("256m");
    expect(out.args[cpuIdx + 1]).toBe("0.5");
    expect(out.args[netIdx + 1]).toBe("metis-mcp-test");
  });

  it("falls back to defaults when tunables are absent", async () => {
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    const memIdx = out.args.indexOf("--memory");
    const cpuIdx = out.args.indexOf("--cpus");
    const netIdx = out.args.indexOf("--network");
    expect(out.args[memIdx + 1]).toBe("512m");
    expect(out.args[cpuIdx + 1]).toBe("1.0");
    expect(out.args[netIdx + 1]).toBe("metis-mcp");
  });

  it("creates the documented /workspace directory for filesystem MCP wrappers", async () => {
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({
        runtime: "docker-stdio",
        command: "ghcr.io/metis-mcps/npx-runner:1.0.0",
        args: [],
      }),
      {},
    );
    const tmpfsIdx = out.args.indexOf("--tmpfs");
    expect(out.args[tmpfsIdx + 1]).toBe("/workspace:rw,nosuid,nodev,size=64m");
  });

  it("rejects images that don't match the allowlist", async () => {
    const p = new DockerStdioProvisioner();
    await expect(
      p.provision(
        baseConfig({
          runtime: "docker-stdio",
          command: "evil.example.com/backdoor:latest",
          args: [],
        }),
        {},
      ),
    ).rejects.toThrow(/IMAGE_NOT_ALLOWED/);
  });

  it("rejects when command (image) is null", async () => {
    const p = new DockerStdioProvisioner();
    await expect(
      p.provision(baseConfig({ runtime: "docker-stdio", command: null }), {}),
    ).rejects.toThrow(/requires `command`/);
  });

  it("filters env keys with invalid names from -e flags", async () => {
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      { GOOD_KEY: "1", "BAD KEY": "2", "1STARTSWITHDIGIT": "3" },
    );
    const eFlags = out.args
      .map((a, i) => (a === "-e" ? out.args[i + 1] : null))
      .filter((x) => x != null);
    expect(eFlags).toContain("GOOD_KEY");
    expect(eFlags).not.toContain("BAD KEY");
    expect(eFlags).not.toContain("1STARTSWITHDIGIT");
  });

  it("cleanup hook invokes the configured runner with the container name", async () => {
    const cleanupRunner = vi.fn(async () => undefined);
    const p = new DockerStdioProvisioner({ cleanupRunner });
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    await out.cleanup?.();
    expect(cleanupRunner).toHaveBeenCalledTimes(1);
    expect(cleanupRunner.mock.calls[0]?.[0]).toMatch(/^metis-mcp-/);
  });

  it("cleanup hook swallows runner errors (best-effort semantics)", async () => {
    const cleanupRunner = vi.fn(async () => {
      throw new Error("daemon down");
    });
    const p = new DockerStdioProvisioner({ cleanupRunner });
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    await expect(out.cleanup?.()).resolves.toBeUndefined();
  });

  it("respects custom dockerBinary option", async () => {
    const p = new DockerStdioProvisioner({ dockerBinary: "/custom/path/docker" });
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    expect(out.command).toBe("/custom/path/docker");
  });

  // Issue #305 — OWASP A07 audit: secret values must never appear in argv.
  it("never leaks secret env values into argv (OWASP A07 / issue #305)", async () => {
    const p = new DockerStdioProvisioner();
    const secretValue = "ghp_supersecret_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const vaultLikePlaceholder = "${vault:github.token}";
    const out = await p.provision(
      baseConfig({
        runtime: "docker-stdio",
        command: "ghcr.io/metis-mcps/uvx-runner:1.0",
        args: ["mcp-foo"],
      }),
      {
        GITHUB_TOKEN: secretValue,
        ATLASSIAN_API_TOKEN: vaultLikePlaceholder,
        ANOTHER_SECRET: "very-secret-value-do-not-leak",
      },
    );
    // The argv must contain only `-e KEY` pairs, never `=VALUE`.
    for (const arg of out.args) {
      expect(arg).not.toContain(secretValue);
      expect(arg).not.toContain(vaultLikePlaceholder);
      expect(arg).not.toContain("very-secret-value-do-not-leak");
      // Stronger guard: no argv token should look like an env-var assignment
      // (`KEY=VALUE`) for any of the supplied keys.
      expect(arg.startsWith("GITHUB_TOKEN=")).toBe(false);
      expect(arg.startsWith("ATLASSIAN_API_TOKEN=")).toBe(false);
      expect(arg.startsWith("ANOTHER_SECRET=")).toBe(false);
    }
    // Values must travel via spawn's env map, not argv.
    expect(out.env.GITHUB_TOKEN).toBe(secretValue);
    expect(out.env.ATLASSIAN_API_TOKEN).toBe(vaultLikePlaceholder);
    expect(out.env.ANOTHER_SECRET).toBe("very-secret-value-do-not-leak");
  });

  it("default cleanup runner shells out to `docker rm -f` and resolves on exit", async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const ee = new EventEmitter();
      // Resolve via the exit handler — verifies the listener is wired.
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    });
    const p = new DockerStdioProvisioner({ dockerBinary: "docker-bin" });
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    await out.cleanup?.();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [bin, argv] = spawnMock.mock.calls[0]!;
    expect(bin).toBe("docker-bin");
    expect(argv).toEqual(["rm", "-f", expect.stringMatching(/^metis-mcp-/)]);
  });

  it("default cleanup runner resolves even when spawn emits `error`", async () => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const ee = new EventEmitter();
      setImmediate(() => ee.emit("error", new Error("ENOENT")));
      return ee;
    });
    const p = new DockerStdioProvisioner();
    const out = await p.provision(
      baseConfig({ runtime: "docker-stdio", command: "ghcr.io/metis-mcps/x", args: [] }),
      {},
    );
    await expect(out.cleanup?.()).resolves.toBeUndefined();
  });
});

describe("buildContainerName", () => {
  it("produces metis-mcp-<id>-<short> form", () => {
    const name = buildContainerName("srv-abc");
    expect(name).toMatch(/^metis-mcp-srv-abc-[a-f0-9]+$/);
  });

  it("strips disallowed characters from the id", () => {
    const name = buildContainerName("srv abc!*");
    expect(name).toMatch(/^metis-mcp-srvabc-[a-f0-9]+$/);
  });

  it("falls back to anon when id has no valid chars", () => {
    const name = buildContainerName("!!!");
    expect(name).toMatch(/^metis-mcp-anon-[a-f0-9]+$/);
  });
});
