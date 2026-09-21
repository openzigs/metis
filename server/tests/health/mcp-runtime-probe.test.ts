/**
 * Issue #330 — `probeMCPRuntime` unit tests.
 *
 * Each substrate condition is mocked end-to-end. No real docker daemon /
 * kubeconfig is touched.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
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
