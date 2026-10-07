/**
 * #797 — the Servers tab showed nothing after Test, and a row stayed
 * `idle · 0 tools` after Start until a full reload.
 *
 * - Test must surface its result inline: ok/error, latency, tool count, and
 *   the error message when the probe failed.
 * - Start/Stop/Restart must poll the list (bounded) until the row leaves its
 *   transitional status, so `starting → ready · 13` shows without a reload.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "../test-utils";
import { McpServersPanel } from "@/components/mcp/mcp-servers-panel";
import { ApiError } from "@/lib/api-client";
import { mcpApi, type MCPServerView, type MCPToolDescriptor } from "@/lib/mcp-api";

vi.mock("@/lib/mcp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-api")>("@/lib/mcp-api");
  return {
    ...actual,
    mcpApi: {
      ...actual.mcpApi,
      list: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      test: vi.fn(),
    },
  };
});

const listMock = vi.mocked(mcpApi.list);
const startMock = vi.mocked(mcpApi.start);
const stopMock = vi.mocked(mcpApi.stop);
const restartMock = vi.mocked(mcpApi.restart);
const testMock = vi.mocked(mcpApi.test);

const TOOLS: MCPToolDescriptor[] = Array.from({ length: 13 }, (_, i) => ({
  name: `tool-${i}`,
  description: `Tool ${i}`,
  risk: "low",
}));

function server(over: Partial<MCPServerView> = {}): MCPServerView {
  return {
    id: "srv-1",
    scope: "global",
    projectId: null,
    label: "Filesystem",
    transport: "stdio",
    runtime: "native",
    command: "npx",
    args: [],
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    unboundSecretRefs: [],
    trustLevel: "untrusted",
    defaultToolRisk: "low",
    version: null,
    sha256: null,
    toolAllowlist: null,
    requireApproval: false,
    toolSchemaApprovedAt: null,
    hasApprovedSchemaSnapshot: false,
    status: "idle",
    lastHealthCheckAt: null,
    latencyMs: null,
    failureCount: 0,
    lastError: null,
    healthCheckIntervalSec: 60,
    enabled: true,
    capabilities: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function renderPanel(props: { pollIntervalMs?: number; pollTimeoutMs?: number } = {}) {
  const Wrapper = makeWrapper({ initialUser: TEST_USER });
  return render(<McpServersPanel pollIntervalMs={10} pollTimeoutMs={5_000} {...props} />, {
    wrapper: Wrapper,
  });
}

function row() {
  return screen.getByTestId("mcp-status-srv-1").closest("tr")!;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockReset();
  listMock.mockResolvedValue({ items: [server()] });
});

describe("MCP servers — Test result (#797)", () => {
  it("shows ok, latency and tool count after a successful Test", async () => {
    testMock.mockResolvedValue({ ok: true, latencyMs: 1, tools: TOOLS });
    renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    fireEvent.click(within(row()).getByRole("button", { name: "Test" }));
    const result = await screen.findByTestId("mcp-test-result-srv-1");
    expect(result).toHaveTextContent(/ok/i);
    expect(result).toHaveTextContent("1 ms");
    expect(result).toHaveTextContent("13 tools");
    expect(testMock).toHaveBeenCalledWith("srv-1");
  });

  it("shows the error message when the probe is not ok", async () => {
    testMock.mockResolvedValue({ ok: false, latencyMs: 42, tools: [], error: "spawn ENOENT" });
    renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    fireEvent.click(within(row()).getByRole("button", { name: "Test" }));
    const result = await screen.findByTestId("mcp-test-result-srv-1");
    expect(result).toHaveTextContent(/failed/i);
    expect(result).toHaveTextContent("42 ms");
    expect(result).toHaveTextContent("spawn ENOENT");
  });

  it("shows the API error when the Test request itself fails", async () => {
    testMock.mockRejectedValue(new ApiError(500, "server exploded", "MCP_ERROR"));
    renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    fireEvent.click(within(row()).getByRole("button", { name: "Test" }));
    const result = await screen.findByTestId("mcp-test-result-srv-1");
    expect(result).toHaveTextContent("server exploded");
  });
});

describe("MCP servers — status refresh after lifecycle actions (#797)", () => {
  it("polls after Start until the row shows ready with its tool count", async () => {
    startMock.mockResolvedValue(server({ status: "starting" }));
    renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("idle");

    listMock
      .mockResolvedValueOnce({ items: [server({ status: "starting" })] })
      .mockResolvedValueOnce({ items: [server({ status: "starting" })] })
      .mockResolvedValue({ items: [server({ status: "ready", capabilities: TOOLS })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Start" }));

    await waitFor(() => expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("ready"));
    expect(screen.getByTestId("mcp-tools-srv-1")).toHaveTextContent("13");

    // Settled — polling stops.
    await sleep(30);
    const calls = listMock.mock.calls.length;
    await sleep(80);
    expect(listMock.mock.calls.length).toBe(calls);
  });

  it("keeps polling while the row still reads idle right after Start", async () => {
    // The start response can race the lifecycle and come back still `idle`.
    startMock.mockResolvedValue(server({ status: "idle" }));
    renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    listMock
      .mockResolvedValueOnce({ items: [server({ status: "idle" })] })
      .mockResolvedValueOnce({ items: [server({ status: "idle" })] })
      .mockResolvedValue({ items: [server({ status: "ready", capabilities: TOOLS })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("ready"));
    expect(screen.getByTestId("mcp-tools-srv-1")).toHaveTextContent("13");
  });

  it("reflects the Start response immediately, before the refetch lands", async () => {
    startMock.mockResolvedValue(server({ status: "starting" }));
    renderPanel({ pollIntervalMs: 60_000 });
    await screen.findByTestId("mcp-status-srv-1");
    listMock.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(within(row()).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("starting"),
    );
  });

  it("polls after Restart and after Stop", async () => {
    restartMock.mockResolvedValue(server({ status: "starting" }));
    stopMock.mockResolvedValue(server({ status: "idle" }));
    listMock.mockResolvedValue({ items: [server({ status: "ready", capabilities: TOOLS })] });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("ready"));

    listMock.mockResolvedValue({ items: [server({ status: "idle" })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("idle"));
    expect(screen.getByTestId("mcp-tools-srv-1")).toHaveTextContent("0");

    listMock
      .mockResolvedValueOnce({ items: [server({ status: "starting" })] })
      .mockResolvedValue({ items: [server({ status: "ready", capabilities: TOOLS })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Restart" }));
    await waitFor(() => expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("ready"));
    expect(restartMock).toHaveBeenCalledWith("srv-1");
    expect(stopMock).toHaveBeenCalledWith("srv-1");
  });

  it("stops polling once the bounded window elapses", async () => {
    startMock.mockResolvedValue(server({ status: "starting" }));
    renderPanel({ pollIntervalMs: 10, pollTimeoutMs: 60 });
    await screen.findByTestId("mcp-status-srv-1");
    listMock.mockResolvedValue({ items: [server({ status: "starting" })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(screen.getByTestId("mcp-status-srv-1")).toHaveTextContent("starting"),
    );
    await sleep(150);
    const calls = listMock.mock.calls.length;
    await sleep(80);
    expect(listMock.mock.calls.length).toBe(calls);
  });

  it("stops polling on unmount", async () => {
    startMock.mockResolvedValue(server({ status: "starting" }));
    const { unmount } = renderPanel();
    await screen.findByTestId("mcp-status-srv-1");
    listMock.mockResolvedValue({ items: [server({ status: "starting" })] });
    fireEvent.click(within(row()).getByRole("button", { name: "Start" }));
    await waitFor(() => expect(listMock.mock.calls.length).toBeGreaterThan(3));
    unmount();
    const calls = listMock.mock.calls.length;
    await sleep(80);
    expect(listMock.mock.calls.length).toBe(calls);
  });
});
