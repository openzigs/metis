/**
 * #31 — the MCP servers panel (was Admin → MCP servers, now the Servers tab of
 * Settings → MCP servers): the scope filter, the rows, their actions and the
 * create form's submit path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import { McpServersPanel } from "@/components/mcp/mcp-servers-panel";
import { ApiError } from "@/lib/api-client";
import { mcpApi, type MCPServerView } from "@/lib/mcp-api";

vi.mock("@/lib/mcp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-api")>("@/lib/mcp-api");
  return {
    ...actual,
    mcpApi: {
      ...actual.mcpApi,
      list: vi.fn(),
      create: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      restart: vi.fn(),
      test: vi.fn(),
      remove: vi.fn(),
    },
  };
});

const api = vi.mocked(mcpApi);

function server(over: Partial<MCPServerView> = {}): MCPServerView {
  return {
    id: "s1",
    scope: "global",
    projectId: null,
    label: "Filesystem",
    transport: "stdio",
    runtime: "native",
    command: "node",
    args: null,
    url: null,
    headers: null,
    env: null,
    envSecretRefs: null,
    enabled: true,
    trustLevel: "untrusted",
    defaultToolRisk: "medium",
    version: null,
    sha256: null,
    toolAllowlist: null,
    requireApproval: false,
    toolSchemaApprovedAt: null,
    hasApprovedSchemaSnapshot: false,
    status: "ready",
    lastHealthCheckAt: null,
    latencyMs: null,
    failureCount: 0,
    lastError: null,
    healthCheckIntervalSec: 60,
    capabilities: [],
    createdAt: "2026-04-25T00:00:00Z",
    updatedAt: "2026-04-25T00:00:00Z",
    ...over,
  } as MCPServerView;
}

function renderPanel(props: Parameters<typeof McpServersPanel>[0] = {}) {
  return render(<McpServersPanel {...props} />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, permissions: ["mcp.manage"] } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue({
    items: [
      server(),
      server({ id: "s2", label: "Mine", scope: "user", lastError: "boom", status: "error" }),
      server({ id: "s3", label: "Proj", scope: "project", projectId: "p1", trustLevel: "trusted" }),
    ],
  });
  for (const fn of [api.start, api.stop, api.restart]) {
    fn.mockResolvedValue(server());
  }
  api.test.mockResolvedValue({ ...server(), ok: true, latencyMs: 1, tools: [] });
  api.remove.mockResolvedValue(undefined);
  api.create.mockResolvedValue(server());
});

describe("<McpServersPanel /> scope filter (#31)", () => {
  it("lists every scope by default and labels each row's scope", async () => {
    renderPanel();
    expect(await screen.findByTestId("mcp-scope-s1")).toHaveTextContent("Global");
    // Global servers have no workspace — they are platform-wide (#389 review).
    expect(screen.getByRole("option", { name: "Global" })).toHaveValue("global");
    expect(screen.queryByRole("option", { name: "Workspace" })).not.toBeInTheDocument();
    expect(screen.getByTestId("mcp-scope-s2")).toHaveTextContent("Mine");
    expect(screen.getByTestId("mcp-scope-s3")).toHaveTextContent("Project");
    expect(api.list).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it.each([
    ["user", "user"],
    ["project", "project"],
    ["global", "global"],
  ] as const)("asks the server for %s-scope servers only", async (value, scope) => {
    renderPanel();
    await screen.findByTestId("mcp-scope-s1");
    fireEvent.change(screen.getByLabelText("Scope"), { target: { value } });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ scope }));
  });

  it("starts from the scope it is given", async () => {
    renderPanel({ initialScope: "project" });
    await waitFor(() => expect(api.list).toHaveBeenCalledWith({ scope: "project" }));
    expect(screen.getByLabelText("Scope")).toHaveValue("project");
  });

  it("says a filtered scope is empty, distinct from an empty registry", async () => {
    api.list.mockResolvedValue({ items: [] });
    renderPanel({ initialScope: "user" });
    expect(await screen.findByText("No MCP servers in this scope.")).toBeInTheDocument();
  });

  it("says the registry is empty when no scope is filtered", async () => {
    api.list.mockResolvedValue({ items: [] });
    renderPanel();
    expect(await screen.findByText("No MCP servers registered yet.")).toBeInTheDocument();
  });
});

describe("<McpServersPanel /> row actions", () => {
  it.each([
    ["Start", "start"],
    ["Stop", "stop"],
    ["Restart", "restart"],
    ["Test", "test"],
  ] as const)("%s calls the API for that server and refreshes the list", async (label, fn) => {
    renderPanel();
    const row = (await screen.findByTestId("mcp-scope-s3")).closest("tr")!;
    const calls = api.list.mock.calls.length;
    fireEvent.click(within(row).getByRole("button", { name: label }));
    await waitFor(() => expect(api[fn]).toHaveBeenCalledWith("s3"));
    await waitFor(() => expect(api.list.mock.calls.length).toBeGreaterThan(calls));
  });

  it("deletes a server only after confirmation", async () => {
    renderPanel();
    const row = (await screen.findByTestId("mcp-scope-s1")).closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: "Delete" }));
    expect(api.remove).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("s1"));
  });
});

describe("<McpServersPanel /> create form", () => {
  async function openForm() {
    renderPanel();
    fireEvent.click(await screen.findByTestId("new-mcp-server"));
    return screen.findByTestId("mcp-label");
  }

  it("registers a stdio server with its command and args", async () => {
    fireEvent.change(await openForm(), { target: { value: "fs" } });
    fireEvent.change(screen.getByTestId("mcp-command-input"), { target: { value: "npx" } });
    fireEvent.click(screen.getByTestId("mcp-create-submit"));
    await waitFor(() =>
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({ label: "fs", transport: "stdio", command: "npx", args: [] }),
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("mcp-label")).not.toBeInTheDocument());
  });

  it("shows the server's error message when registration fails", async () => {
    api.create.mockRejectedValue(new ApiError(400, "label taken", "BAD"));
    fireEvent.change(await openForm(), { target: { value: "fs" } });
    fireEvent.change(screen.getByTestId("mcp-command-input"), { target: { value: "npx" } });
    fireEvent.click(screen.getByTestId("mcp-create-submit"));
    expect(await screen.findByText("label taken")).toBeInTheDocument();
  });

  it("falls back to a generic message for a non-API failure", async () => {
    api.create.mockRejectedValue(new Error("network"));
    fireEvent.change(await openForm(), { target: { value: "fs" } });
    fireEvent.change(screen.getByTestId("mcp-command-input"), { target: { value: "npx" } });
    fireEvent.click(screen.getByTestId("mcp-create-submit"));
    expect(await screen.findByText("Failed to register server")).toBeInTheDocument();
  });
});
