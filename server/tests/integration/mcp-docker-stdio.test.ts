/**
 * Sub-issue #284 — End-to-end smoke test for the docker-stdio runtime.
 *
 * Skipped unless `MCP_INTEGRATION_TESTS=1` is set, because it requires:
 *   - a working Docker daemon reachable from the test host
 *   - the `metis-mcp` Docker network (create with `docker network create metis-mcp`)
 *   - network access to pull `ghcr.io/github/github-mcp-server`
 *
 * The test boots the lifecycle manager with a real `docker run -i --rm`
 * subprocess, performs a full MCP handshake, lists tools, then stops the
 * server and asserts the container is reaped within 10 seconds.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { MCPLifecycleManager } from "../../src/lib/mcp/lifecycle-manager.js";
import { buildContainerName } from "../../src/lib/mcp/provisioners/docker-stdio.js";
import type { MCPServerConfig } from "../../src/lib/mcp/types.js";
import { getConfigService } from "../../src/lib/config/config-service.js";

const enabled = process.env.MCP_INTEGRATION_TESTS === "1";
const describeIf = enabled ? describe : describe.skip;

function dockerHasContainer(name: string): boolean {
  const result = spawnSync("docker", ["ps", "--filter", `name=${name}`, "--format", "{{.Names}}"], {
    encoding: "utf8",
  });
  return result.stdout.trim().split("\n").includes(name);
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

describeIf("MCP docker-stdio runtime — end-to-end (#284)", () => {
  const serverId = `it-${randomUUID().slice(0, 8)}`;
  const containerName = buildContainerName(serverId);
  let manager: MCPLifecycleManager;

  beforeAll(async () => {
    const cfg = getConfigService();
    await cfg.set("MCP_IMAGE_ALLOWLIST", "ghcr.io/github/github-mcp-server", "test");
    manager = new MCPLifecycleManager({});
  });

  afterAll(async () => {
    if (manager) await manager.stop(serverId).catch(() => undefined);
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
  });

  it("starts a docker-stdio MCP, lists tools, then cleans up", async () => {
    const config: MCPServerConfig = {
      id: serverId,
      scope: "global",
      projectId: null,
      label: "github-mcp (integration)",
      transport: "stdio",
      runtime: "docker-stdio",
      command: "ghcr.io/github/github-mcp-server",
      args: [],
      url: null,
      headers: null,
      env: {},
      envSecretRefs: null,
      trustLevel: "trusted",
      defaultToolRisk: "low",
      version: null,
      sha256: null,
      healthCheckIntervalSec: 60,
      enabled: true,
    };

    const state = await manager.start(config);
    expect(state.status).toBe("ready");

    expect(dockerHasContainer(containerName)).toBe(true);

    const snapshot = manager.get(serverId);
    expect(snapshot).not.toBeNull();
    expect(Array.isArray(snapshot!.state.tools)).toBe(true);
    expect(snapshot!.state.tools.length).toBeGreaterThan(0);

    await manager.stop(serverId);
    const reaped = await waitFor(() => !dockerHasContainer(containerName), 10_000);
    expect(reaped).toBe(true);
  }, 180_000);
});
