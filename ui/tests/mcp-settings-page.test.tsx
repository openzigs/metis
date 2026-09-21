import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";
import McpSettingsPage, {
  McpApprovalPrompt,
  type ApprovalPromptData,
} from "@/app/(authed)/settings/mcp/page";
import { mcpApi, mcpPlatformApi, type MCPServerView } from "@/lib/mcp-api";

vi.mock("@/lib/mcp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-api")>("@/lib/mcp-api");
  return {
    ...actual,
    mcpApi: {
      ...actual.mcpApi,
      list: vi.fn(),
    },
    mcpPlatformApi: {
      registry: vi.fn(),
      install: vi.fn(),
      tools: vi.fn(),
      testTool: vi.fn(),
      integrityDiff: vi.fn(),
      approveSnapshot: vi.fn(),
      setGovernance: vi.fn(),
      decideApproval: vi.fn(),
      exportJson: vi.fn(),
      importCopilot: vi.fn(),
      scanHiddenChars: vi.fn(),
    },
  };
});

const listMock = vi.mocked(mcpApi.list);
const registryMock = vi.mocked(mcpPlatformApi.registry);
const installMock = vi.mocked(mcpPlatformApi.install);
const testToolMock = vi.mocked(mcpPlatformApi.testTool);
const setGovernanceMock = vi.mocked(mcpPlatformApi.setGovernance);
const integrityDiffMock = vi.mocked(mcpPlatformApi.integrityDiff);
const importCopilotMock = vi.mocked(mcpPlatformApi.importCopilot);

function makeServer(over: Partial<MCPServerView> = {}): MCPServerView {
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
    version: "1.0.0",
    sha256: "a".repeat(64),
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
    capabilities: [
      { name: "read_file", description: "read", risk: "medium" },
      { name: "write_file", description: "write", risk: "high" },
    ],
    createdAt: "2026-04-25T00:00:00Z",
    updatedAt: "2026-04-25T00:00:00Z",
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [makeServer()] });
  registryMock.mockResolvedValue({
    fetchedAt: "2026-04-25T00:00:00Z",
    stale: false,
    fromCache: false,
    total: 1,
    servers: [
      {
        id: "fs",
        name: "Filesystem MCP",
        description: "Local FS access",
        version: "1.0.0",
        publisher: "modelcontextprotocol",
        category: "filesystem",
        install: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem"],
        },
      },
    ],
  });
  integrityDiffMock.mockResolvedValue({
    diff: { added: [], removed: [], changed: [] },
    approvedAt: null,
    hasBaseline: false,
    version: "1.0.0",
    sha256: "a".repeat(64),
  });
});

describe("McpSettingsPage — Connected tab", () => {
  it("renders the registered servers and exposes Tools, Allowlist, Approval, Integrity panels", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    expect(await screen.findByText(/Filesystem/)).toBeInTheDocument();
    expect(screen.getByTestId("tools-s1")).toBeInTheDocument();
    expect(screen.getByTestId("allowlist-s1")).toBeInTheDocument();
    expect(screen.getByTestId("require-approval-s1")).toBeInTheDocument();
    expect(screen.getByTestId("integrity-s1")).toBeInTheDocument();
  });

  it("runs a tool via the inline tester and renders the result", async () => {
    testToolMock.mockResolvedValue({
      result: { ok: true, bytes: 42 },
      isError: false,
      durationMs: 17,
    });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    fireEvent.change(screen.getByTestId("tool-args-s1"), {
      target: { value: '{"path":"/tmp/x"}' },
    });
    fireEvent.click(screen.getByTestId("tool-run-s1"));
    await waitFor(() => expect(testToolMock).toHaveBeenCalledTimes(1));
    expect(testToolMock).toHaveBeenCalledWith("s1", "read_file", { path: "/tmp/x" });
    const result = await screen.findByTestId("tool-result-s1");
    expect(result.textContent).toMatch(/OK/);
    expect(result.textContent).toMatch(/17 ms/);
  });

  it("saves the per-server allowlist", async () => {
    setGovernanceMock.mockResolvedValue(makeServer({ toolAllowlist: ["read_file"] }));
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    fireEvent.change(screen.getByTestId("allowlist-input-s1"), {
      target: { value: "read_file\nwrite_file" },
    });
    fireEvent.click(screen.getByTestId("allowlist-save-s1"));
    await waitFor(() => expect(setGovernanceMock).toHaveBeenCalledTimes(1));
    expect(setGovernanceMock).toHaveBeenCalledWith("s1", {
      toolAllowlist: ["read_file", "write_file"],
    });
  });
});

describe("McpSettingsPage — Registry tab", () => {
  it("lists registry entries and opens the install dialog", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-registry"));
    expect(await screen.findByTestId("registry-list")).toBeInTheDocument();
    expect(screen.getByText("Filesystem MCP")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("registry-install-fs"));
    expect(await screen.findByTestId("install-confirm")).toBeInTheDocument();
  });

  it("calls install with the chosen scope", async () => {
    installMock.mockResolvedValue(makeServer({ id: "new" }));
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-registry"));
    await screen.findByText("Filesystem MCP");
    fireEvent.click(screen.getByTestId("registry-install-fs"));
    fireEvent.click(await screen.findByTestId("install-confirm"));
    await waitFor(() => expect(installMock).toHaveBeenCalledTimes(1));
    expect(installMock).toHaveBeenCalledWith({ registryServerId: "fs", scope: "global" });
  });

  it("shows a stale banner when the registry returned cached data", async () => {
    registryMock.mockResolvedValue({
      fetchedAt: "2026-04-24T00:00:00Z",
      stale: true,
      fromCache: true,
      total: 1,
      servers: [
        {
          id: "fs",
          name: "Filesystem MCP",
          description: "x",
        },
      ],
    });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-registry"));
    expect(await screen.findByTestId("registry-stale-banner")).toBeInTheDocument();
  });

  it("shows a clean offline empty state when the registry has no cache", async () => {
    registryMock.mockResolvedValue({
      fetchedAt: "2026-04-24T00:00:00Z",
      stale: false,
      fromCache: false,
      offline: true,
      error: "This operation was aborted",
      total: 0,
      servers: [],
    });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-registry"));
    expect(await screen.findByTestId("registry-offline-banner")).toBeInTheDocument();
    expect(screen.getByTestId("registry-empty")).toHaveTextContent(
      "Registry entries will appear after connectivity returns.",
    );
  });
});

describe("McpSettingsPage — Import / Export tab", () => {
  it("imports the confirmed payload even if the preview clears before the mutation starts", async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      mutationCache: new MutationCache({
        onMutate: async () => {
          entered();
          await resume;
        },
      }),
    });
    const Wrapper = makeWrapper();
    const mcpJson = { servers: { fs: { command: "npx", args: ["-y", "x"], type: "stdio" } } };
    importCopilotMock.mockResolvedValue({
      plan: { entries: [], totalSecrets: 0 },
      created: [],
      errors: [],
      dryRun: false,
    });
    render(
      <Wrapper>
        <QueryClientProvider client={client}>
          <McpSettingsPage />
        </QueryClientProvider>
      </Wrapper>,
    );
    fireEvent.click(screen.getByTestId("tab-import-export"));
    const file = new File([JSON.stringify(mcpJson)], "mcp.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(JSON.stringify(mcpJson)) });
    fireEvent.change(screen.getByTestId("import-file"), { target: { files: [file] } });
    expect(await screen.findByTestId("import-preview")).toHaveTextContent("1 server(s) to import");
    fireEvent.click(screen.getByTestId("import-confirm"));
    await started;
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    await act(async () => {
      release();
    });
    await waitFor(() => expect(importCopilotMock).toHaveBeenCalledExactlyOnceWith({ mcpJson }));
    expect(screen.queryByTestId("import-server-error")).not.toBeInTheDocument();
    client.clear();
  });

  it("previews a parsed mcp.json and triggers import", async () => {
    importCopilotMock.mockResolvedValue({
      created: [],
      errors: [],
      skipped: [],
      warnings: [],
    } as unknown as Awaited<ReturnType<typeof mcpPlatformApi.importCopilot>>);
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-import-export"));
    const input = screen.getByTestId("import-file") as HTMLInputElement;
    const file = new File(
      [JSON.stringify({ servers: { fs: { command: "npx", args: ["-y", "x"], type: "stdio" } } })],
      "mcp.json",
      { type: "application/json" },
    );
    if (typeof (file as unknown as { text?: unknown }).text !== "function") {
      const content = JSON.stringify({
        servers: { fs: { command: "npx", args: ["-y", "x"], type: "stdio" } },
      });
      Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
    }
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId("import-preview")).toHaveTextContent("1 server(s) to import");
    fireEvent.click(screen.getByTestId("import-confirm"));
    await waitFor(() => expect(importCopilotMock).toHaveBeenCalledTimes(1));
  });

  it("surfaces a parse error for invalid JSON", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(screen.getByTestId("tab-import-export"));
    const input = screen.getByTestId("import-file") as HTMLInputElement;
    const file = new File(["{not json"], "mcp.json", { type: "application/json" });
    if (typeof (file as unknown as { text?: unknown }).text !== "function") {
      Object.defineProperty(file, "text", { value: () => Promise.resolve("{not json") });
    }
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId("import-error")).toBeInTheDocument();
  });
});

describe("McpApprovalPrompt", () => {
  function makeData(over: Partial<ApprovalPromptData> = {}): ApprovalPromptData {
    return {
      approvalId: "apv1",
      serverId: "s1",
      serverLabel: "Filesystem",
      toolName: "read_file",
      args: { path: "/etc/passwd" },
      hiddenChars: [],
      ...over,
    };
  }

  it("renders tool description and approve/deny buttons", () => {
    const onDecide = vi.fn();
    render(<McpApprovalPrompt data={makeData()} onDecide={onDecide} />);
    expect(screen.getByTestId("mcp-approval-prompt")).toHaveTextContent("read_file");
    fireEvent.click(screen.getByTestId("approval-approve"));
    expect(onDecide).toHaveBeenCalledWith("approved");
    fireEvent.click(screen.getByTestId("approval-deny"));
    expect(onDecide).toHaveBeenCalledWith("denied");
  });

  it("renders hidden-char badges with counts", () => {
    const onDecide = vi.fn();
    render(
      <McpApprovalPrompt
        data={makeData({
          hiddenChars: [
            { start: 0, end: 1, code: 0x200b, label: "ZWSP" },
            { start: 4, end: 5, code: 0x200b, label: "ZWSP" },
            { start: 7, end: 8, code: 0x202e, label: "RLO" },
          ],
        })}
        onDecide={onDecide}
      />,
    );
    expect(screen.getByTestId("hidden-char-badge-ZWSP")).toHaveTextContent("ZWSP ×2");
    expect(screen.getByTestId("hidden-char-badge-RLO")).toHaveTextContent("RLO ×1");
  });
});

// Issue #58 — screen-reader audit. The section switcher is an ARIA tablist with
// an accessible name, each tab controls a labelled tabpanel, and the selected
// tab is announced via aria-selected. (Previously a `<nav role="tablist">` with
// no name and no panel wiring — a role conflict for SR users.)
describe("McpSettingsPage — tablist screen-reader affordances (#58)", () => {
  it("names the tablist, exposes tab roles, and wires the active tabpanel", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);

    const tablist = screen.getByRole("tablist", { name: "MCP platform sections" });
    expect(tablist).toBeInTheDocument();

    const connected = screen.getByRole("tab", { name: "Connected" });
    expect(connected).toHaveAttribute("aria-selected", "true");
    expect(connected).toHaveAttribute("aria-controls", "tabpanel-connected");

    // The active panel is a tabpanel labelled by its tab.
    const panel = document.getElementById("tabpanel-connected");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", "tab-connected");

    // Switching tabs moves the selection for SR users.
    fireEvent.click(screen.getByRole("tab", { name: "Registry" }));
    expect(screen.getByRole("tab", { name: "Registry" })).toHaveAttribute("aria-selected", "true");
  });
});
