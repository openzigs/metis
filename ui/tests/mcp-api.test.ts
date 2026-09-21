/**
 * Coverage for the Phase 6 + #162 MCP API wrappers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpApi, mcpPlatformApi } from "@/lib/mcp-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("mcpApi", () => {
  it("hits canonical paths for the full server lifecycle", async () => {
    await mcpApi.list();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp", { params: undefined });
    await mcpApi.list({ scope: "global" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp", { params: { scope: "global" } });
    await mcpApi.get("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1");
    await mcpApi.create({ label: "l", transport: "stdio" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp", {
      method: "POST",
      body: { label: "l", transport: "stdio" },
    });
    await mcpApi.update("s1", { enabled: false });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1", {
      method: "PATCH",
      body: { enabled: false },
    });
    await mcpApi.remove("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1", { method: "DELETE" });
    await mcpApi.start("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1/start", { method: "POST" });
    await mcpApi.stop("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1/stop", { method: "POST" });
    await mcpApi.restart("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1/restart", { method: "POST" });
    await mcpApi.test("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/s1/test", { method: "POST" });
    await mcpApi.import({ mcpJson: {}, dryRun: true });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/import", {
      method: "POST",
      body: { mcpJson: {}, dryRun: true },
    });
    await mcpApi.getAllowList("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/projects/p1/allowlist");
    await mcpApi.setAllowList("p1", ["s1", "s2"]);
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/projects/p1/allowlist", {
      method: "PUT",
      body: { serverIds: ["s1", "s2"] },
    });
    await mcpApi.listForProject("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/projects/p1/available");
  });
});

describe("mcpPlatformApi", () => {
  it("hits the v1.1 platform endpoints", async () => {
    await mcpPlatformApi.registry();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/registry", { params: undefined });
    await mcpPlatformApi.registry({ q: "fs", page: 2 });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/registry", {
      params: { q: "fs", page: 2 },
    });
    await mcpPlatformApi.install({ registryServerId: "rs1" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/registry/install", {
      method: "POST",
      body: { registryServerId: "rs1" },
    });
    await mcpPlatformApi.tools("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/servers/s1/tools");
    await mcpPlatformApi.testTool("s1", "echo tool", { x: 1 });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/servers/s1/tools/echo%20tool/test", {
      method: "POST",
      body: { args: { x: 1 } },
    });
    await mcpPlatformApi.integrityDiff("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/servers/s1/integrity/diff");
    await mcpPlatformApi.approveSnapshot("s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/servers/s1/integrity/approve-snapshot", {
      method: "POST",
    });
    await mcpPlatformApi.setGovernance("s1", { requireApproval: true });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/servers/s1/governance", {
      method: "PATCH",
      body: { requireApproval: true },
    });
    await mcpPlatformApi.decideApproval("a1", "approved");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/approvals/a1/decide", {
      method: "POST",
      body: { decision: "approved" },
    });
    await mcpPlatformApi.exportJson();
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/export");
    await mcpPlatformApi.importCopilot({ mcpJson: {} });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/import-copilot", {
      method: "POST",
      body: { mcpJson: {} },
    });
    await mcpPlatformApi.scanHiddenChars("text");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/mcp/scan-hidden-chars", {
      method: "POST",
      body: { text: "text" },
    });
  });
});
