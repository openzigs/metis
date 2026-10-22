/**
 * Issue #330 — `probeMCPRuntime` unit tests.
 *
 * Each substrate condition is mocked end-to-end. No real docker daemon /
 * kubeconfig is touched.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetMcpRuntimeProbeCache,
  probeMCPRuntime,
} from "../../src/health/mcp-runtime-probe.js";

beforeEach(() => {
  __resetMcpRuntimeProbeCache();
});

describe("probeMCPRuntime — runtime=docker-stdio", () => {
  it("returns status=ok when network present, daemon reachable, all wrappers cached", async () => {
    const dockerExec = vi.fn(async (args: string[]) => {
      if (args[0] === "info") return "26.1.4\n";
      if (args[0] === "network" && args[1] === "inspect") return "[]";
      if (args[0] === "image" && args[1] === "ls") return "ghcr.io/metis-mcps/uvx-runner\n";
      throw new Error("unexpected " + args.join(" "));
    });
    const r = await probeMCPRuntime({ runtime: "docker-stdio", dockerExec });
    expect(r.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "dockerSocket")?.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "network")?.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "images")?.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "kubeconfig")?.status).toBe("skip");
  });

  it("flags status=fail and surfaces a remediation hint when the metis-mcp network is missing", async () => {
    const dockerExec = vi.fn(async (args: string[]) => {
      if (args[0] === "info") return "26.1.4";
      if (args[0] === "network") throw new Error("Error: No such network: metis-mcp");
      if (args[0] === "image") return "ghcr.io/metis-mcps/uvx-runner\n";
      throw new Error("unexpected");
    });
    const r = await probeMCPRuntime({ runtime: "docker-stdio", dockerExec });
    expect(r.status).toBe("fail");
    const network = r.checks.find((c) => c.name === "network");
    expect(network?.status).toBe("fail");
    expect(network?.detail).toMatch(/docker network create/);
  });

  it("flags status=fail and lists missing wrapper images", async () => {
    const dockerExec = vi.fn(async (args: string[]) => {
      if (args[0] === "info") return "26.1.4";
      if (args[0] === "network") return "[]";
      if (args[0] === "image") {
        // Only `uvx-runner` cached; others empty.
        return args.includes("ghcr.io/metis-mcps/uvx-runner")
          ? "ghcr.io/metis-mcps/uvx-runner\n"
          : "";
      }
      throw new Error("unexpected");
    });
    const r = await probeMCPRuntime({ runtime: "docker-stdio", dockerExec });
    expect(r.status).toBe("fail");
    const images = r.checks.find((c) => c.name === "images");
    expect(images?.status).toBe("fail");
    expect(images?.detail).toMatch(/jbang-runner.*node-runner.*npx-runner/);
  });

  it("flags status=fail and skips dependent checks when the docker daemon is unreachable", async () => {
    const dockerExec = vi.fn(async () => {
      throw new Error("Cannot connect to the Docker daemon");
    });
    const r = await probeMCPRuntime({ runtime: "docker-stdio", dockerExec });
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.name === "dockerSocket")?.status).toBe("fail");
    // network probe should fail with a daemon-unreachable detail (not actually
    // call the docker CLI a second time)
    const network = r.checks.find((c) => c.name === "network");
    expect(network?.status).toBe("fail");
    expect(network?.detail).toMatch(/docker unreachable/);
    // images skipped — can't probe without daemon.
    expect(r.checks.find((c) => c.name === "images")?.status).toBe("skip");
    // dockerExec called once for `info`, never again.
    expect(dockerExec).toHaveBeenCalledTimes(1);
  });
});

describe("probeMCPRuntime — runtime=k8s-sse", () => {
  it("checks kubeconfig and skips the docker-only sub-checks", async () => {
    const dockerExec = vi.fn(async () => {
      throw new Error("should not be called");
    });
    const r = await probeMCPRuntime({
      runtime: "k8s-sse",
      dockerExec,
      kubeconfigCheck: () => ({ ok: true, detail: "context=test-cluster" }),
    });
    expect(r.status).toBe("ok");
    expect(r.checks.find((c) => c.name === "kubeconfig")).toEqual(
      expect.objectContaining({ status: "ok", detail: "context=test-cluster" }),
    );
    expect(r.checks.find((c) => c.name === "dockerSocket")?.status).toBe("skip");
    expect(r.checks.find((c) => c.name === "network")?.status).toBe("skip");
    expect(r.checks.find((c) => c.name === "images")?.status).toBe("skip");
    expect(dockerExec).not.toHaveBeenCalled();
  });

  it("flags status=fail when kubeconfig has no current context", async () => {
    const r = await probeMCPRuntime({
      runtime: "k8s-sse",
      dockerExec: vi.fn(),
      kubeconfigCheck: () => ({ ok: false, detail: "no current context" }),
    });
    expect(r.status).toBe("fail");
    expect(r.checks.find((c) => c.name === "kubeconfig")?.status).toBe("fail");
  });
});

// #1380 — the tests above inject `kubeconfigCheck`, so none of them ran the
// DEFAULT check, which called `require()` and so failed under the server's ESM
// build (`"type": "module"`) with "require is not defined" on every /readyz.
const KUBECONFIG_YAML = [
  "apiVersion: v1",
  "kind: Config",
  "clusters:",
  "  - name: probe-cluster",
  "    cluster: { server: https://127.0.0.1:6443 }",
  "users:",
  "  - name: probe-user",
  "    user: { token: not-a-real-token }",
  "contexts:",
  "  - name: probe-ctx",
  "    context: { cluster: probe-cluster, user: probe-user }",
  "current-context: probe-ctx",
  "",
].join("\n");

describe("probeMCPRuntime — default kubeconfig check (#1380)", () => {
  let dir: string;
  const saved = {
    KUBECONFIG: process.env.KUBECONFIG,
    KUBERNETES_SERVICE_HOST: process.env.KUBERNETES_SERVICE_HOST,
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "metis-kubeconfig-"));
    writeFileSync(join(dir, "config"), KUBECONFIG_YAML);
    process.env.KUBECONFIG = join(dir, "config");
    delete process.env.KUBERNETES_SERVICE_HOST;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("loads @kubernetes/client-node without an injected check and reports the current context", async () => {
    const r = await probeMCPRuntime({ runtime: "k8s-sse", dockerExec: vi.fn() });
    expect(r.checks.find((c) => c.name === "kubeconfig")).toEqual(
      expect.objectContaining({ status: "ok", detail: "context=probe-ctx" }),
    );
    expect(r.status).toBe("ok");
  });

  it("fails, naming the cause, when the kubeconfig has no current context", async () => {
    writeFileSync(
      join(dir, "config"),
      KUBECONFIG_YAML.replace("current-context: probe-ctx", 'current-context: ""'),
    );
    const r = await probeMCPRuntime({ runtime: "k8s-sse", dockerExec: vi.fn() });
    const kube = r.checks.find((c) => c.name === "kubeconfig");
    expect(kube?.status).toBe("fail");
    expect(kube?.detail).toBe("no current context in kubeconfig");
  });

  // Vitest runs source through its own module runner, which is not the module
  // system the built server runs under. This runs the probe in a plain Node ESM
  // process, where `require` is undefined exactly as in the image.
  it("passes under plain Node ESM, the module system of the built server", async () => {
    const probeUrl = new URL("../../src/health/mcp-runtime-probe.ts", import.meta.url).href;
    const script = [
      `const m = await import(${JSON.stringify(probeUrl)});`,
      `const r = await m.probeMCPRuntime({ runtime: "k8s-sse", dockerExec: async () => "" });`,
      `process.stdout.write(JSON.stringify(r.checks.find((c) => c.name === "kubeconfig")));`,
    ].join("\n");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", script],
      {
        cwd: fileURLToPath(new URL("../..", import.meta.url)),
        env: { ...process.env, KUBECONFIG: join(dir, "config") },
        // Below the test's own timeout, so a slow child surfaces as the child's
        // error (killed, with its stderr) rather than as a bare vitest timeout.
        timeout: 20_000,
      },
    );
    expect(JSON.parse(stdout)).toEqual({
      name: "kubeconfig",
      status: "ok",
      detail: "context=probe-ctx",
    });
  }, 40_000);
});

describe("probeMCPRuntime — caching", () => {
  it("returns the cached snapshot within the 30s TTL", async () => {
    let now = 1_000_000;
    const dockerExec = vi.fn(async (args: string[]) => {
      if (args[0] === "info") return "1.0";
      if (args[0] === "network") return "[]";
      if (args[0] === "image") return "ghcr.io/metis-mcps/x\n";
      return "";
    });
    const opts = { runtime: "docker-stdio", dockerExec, now: () => now };
    await probeMCPRuntime(opts);
    const callsAfterFirst = dockerExec.mock.calls.length;
    // Within TTL — should not invoke dockerExec again.
    now += 10_000;
    await probeMCPRuntime(opts);
    expect(dockerExec.mock.calls.length).toBe(callsAfterFirst);

    // After TTL elapses — fresh probe.
    now += 30_000;
    await probeMCPRuntime(opts);
    expect(dockerExec.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
