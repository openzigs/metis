import { describe, it, expect, vi, beforeEach } from "vitest";
import userEvent from "@testing-library/user-event";
import { expectApgTabKeyboard } from "./a11y/tab-keyboard";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { makeWrapper } from "./test-utils";
import { useSearchParams } from "next/navigation";
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
    unboundSecretRefs: [],
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
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
    expect(await screen.findByTestId("registry-list")).toBeInTheDocument();
    expect(screen.getByText("Filesystem MCP")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("registry-install-fs"));
    expect(await screen.findByTestId("install-confirm")).toBeInTheDocument();
  });

  // #335 — this page has no project context. Offering "Project" sent
  // scope:"project" with no projectId, which stored a server bound to no
  // project; the dialog installs globally only (attach per project via the
  // project's allow-list).
  it("does not offer Project scope: there is no project to bind it to", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
    await screen.findByText("Filesystem MCP");
    fireEvent.click(screen.getByTestId("registry-install-fs"));
    await screen.findByTestId("install-confirm");
    expect(screen.queryByRole("option", { name: /project/i })).toBeNull();
    expect(screen.queryByTestId("install-scope")).toBeNull();
    expect(screen.getByTestId("install-scope-note")).toHaveTextContent(/global/i);
  });

  it("calls install with the global scope", async () => {
    installMock.mockResolvedValue(makeServer({ id: "new" }));
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
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
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
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
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
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
    fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
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
    fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
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
    fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
    const input = screen.getByTestId("import-file") as HTMLInputElement;
    const file = new File(["{not json"], "mcp.json", { type: "application/json" });
    if (typeof (file as unknown as { text?: unknown }).text !== "function") {
      Object.defineProperty(file, "text", { value: () => Promise.resolve("{not json") });
    }
    fireEvent.change(input, { target: { files: [file] } });
    expect(await screen.findByTestId("import-error")).toBeInTheDocument();
  });
});

// #621 — the import result: which servers were registered, which were saved
// with a warning (#608), and which failed — and a 207 read as a partial success.
describe("McpSettingsPage — Import result (#621)", () => {
  type ImportResponse = Awaited<ReturnType<typeof mcpPlatformApi.importCopilot>>;

  async function importWith(response: ImportResponse) {
    importCopilotMock.mockResolvedValue(response);
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
    const content = JSON.stringify({ servers: { fs: { command: "npx" }, gh: { command: "gh" } } });
    const file = new File([content], "mcp.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
    fireEvent.change(screen.getByTestId("import-file"), { target: { files: [file] } });
    await screen.findByTestId("import-preview");
    fireEvent.click(screen.getByTestId("import-confirm"));
    return screen.findByTestId("import-result");
  }

  const plan = { entries: [], totalSecrets: 0 };

  it("clean: lists every created server and reports a plain success", async () => {
    const result = await importWith({
      plan,
      created: [
        { id: "s1", label: "fs" },
        { id: "s2", label: "gh" },
      ],
      errors: [],
      dryRun: false,
    });
    expect(result).toHaveAttribute("data-outcome", "success");
    expect(screen.getByTestId("import-result-status")).toHaveTextContent("Imported 2 server(s)");
    const created = screen.getAllByTestId("import-result-created");
    expect(created.map((li) => li.textContent)).toEqual(["fs", "gh"]);
    expect(screen.queryByTestId("import-result-warning")).not.toBeInTheDocument();
    expect(screen.queryByTestId("import-result-failed")).not.toBeInTheDocument();
    // The preview gives way to the result once the import lands.
    expect(screen.queryByTestId("import-preview")).not.toBeInTheDocument();
  });

  it("warned: flags the created server that landed with a warning, with its message and code", async () => {
    const result = await importWith({
      plan,
      created: [
        { id: "s1", label: "fs" },
        { id: "s2", label: "gh", warning: { message: "view failed", code: "VIEW_FAILED" } },
      ],
      errors: [],
      dryRun: false,
    });
    expect(result).toHaveAttribute("data-outcome", "partial");
    expect(screen.getByTestId("import-result-status")).toHaveTextContent(
      "Partially imported: 2 server(s) created, 1 with a warning, 0 failed",
    );
    const warnings = screen.getAllByTestId("import-result-warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toHaveTextContent("view failed");
    expect(warnings[0]).toHaveTextContent("VIEW_FAILED");
    const created = screen.getAllByTestId("import-result-created");
    expect(created[0]).not.toHaveTextContent("view failed");
    expect(created[1]).toHaveTextContent("gh");
    expect(created[1]).toContainElement(warnings[0]!);
  });

  it("failed: lists failed entries with their message and code beside the created ones", async () => {
    const result = await importWith({
      plan,
      created: [{ id: "s1", label: "fs" }],
      errors: [
        { label: "gh", message: "secret not yours", code: "SECRET_BINDING_UNCHECKED" },
        { label: "db", message: "boom" },
      ],
      dryRun: false,
    });
    expect(result).toHaveAttribute("data-outcome", "partial");
    expect(screen.getByTestId("import-result-status")).toHaveTextContent(
      "Partially imported: 1 server(s) created, 0 with a warning, 2 failed",
    );
    const failed = screen.getAllByTestId("import-result-failed");
    expect(failed).toHaveLength(2);
    expect(failed[0]).toHaveTextContent("gh");
    expect(failed[0]).toHaveTextContent("secret not yours");
    expect(failed[0]).toHaveTextContent("SECRET_BINDING_UNCHECKED");
    expect(failed[1]).toHaveTextContent("db");
    expect(failed[1]).toHaveTextContent("boom");
    expect(screen.getAllByTestId("import-result-created").map((li) => li.textContent)).toEqual([
      "fs",
    ]);
  });

  it("failed: an import where every entry failed reads as a failure, not a success", async () => {
    const result = await importWith({
      plan,
      created: [],
      errors: [{ label: "gh", message: "label taken", code: "LABEL_TAKEN" }],
      dryRun: false,
    });
    expect(result).toHaveAttribute("data-outcome", "failed");
    expect(screen.getByTestId("import-result-status")).toHaveTextContent(
      "Import failed: 1 server(s) failed",
    );
    expect(screen.queryByTestId("import-result-created")).not.toBeInTheDocument();
  });

  it("clears the previous result when a new file is chosen", async () => {
    await importWith({ plan, created: [{ id: "s1", label: "fs" }], errors: [], dryRun: false });
    const content = JSON.stringify({ servers: { x: { command: "x" } } });
    const file = new File([content], "mcp.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
    fireEvent.change(screen.getByTestId("import-file"), { target: { files: [file] } });
    await screen.findByTestId("import-preview");
    expect(screen.queryByTestId("import-result")).not.toBeInTheDocument();
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
    // The active panel is a tabpanel labelled by its tab (ids are Radix's).
    const panel = document.getElementById(connected.getAttribute("aria-controls") ?? "");
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("role", "tabpanel");
    expect(panel).toHaveAttribute("aria-labelledby", connected.id);

    // Switching tabs moves the selection for SR users.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Registry" }));
    expect(screen.getByRole("tab", { name: "Registry" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("McpSettingsPage — keyboard (#268)", () => {
  it("arrow keys move between the section tabs (APG Tabs)", async () => {
    const user = userEvent.setup();
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    await expectApgTabKeyboard(user, "MCP platform sections");
  });
});

describe("McpSettingsPage — one home for MCP servers (#31)", () => {
  it("opens the Servers tab (the former Admin → MCP servers) when the URL asks for it", async () => {
    vi.mocked(useSearchParams).mockReturnValueOnce(
      new URLSearchParams("tab=servers") as ReturnType<typeof useSearchParams>,
    );
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    expect(screen.getByRole("tab", { name: "Servers" })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByTestId("mcp-scope-filter")).toBeInTheDocument();
    expect(screen.getByTestId("new-mcp-server")).toBeInTheDocument();
  });

  it("falls back to Connected for a tab it does not have", () => {
    vi.mocked(useSearchParams).mockReturnValueOnce(
      new URLSearchParams("tab=nope") as ReturnType<typeof useSearchParams>,
    );
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    expect(screen.getByRole("tab", { name: "Connected" })).toHaveAttribute("aria-selected", "true");
  });
});

// #529 — the paths #508 left untested, lifting settings/mcp/page.tsx past the
// 80% lines floor. Each asserts the behaviour a user sees, not just a render.
describe("McpSettingsPage — Connected tab edge paths (#529)", () => {
  it("says so when no servers are registered", async () => {
    listMock.mockResolvedValue({ items: [] });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    expect(await screen.findByTestId("connected-empty")).toHaveTextContent(
      /No MCP servers registered yet/,
    );
    expect(screen.queryByTestId("connected-list")).toBeNull();
  });

  it("tells the user to start a server that advertises no tools, with no tester", async () => {
    listMock.mockResolvedValue({ items: [makeServer({ capabilities: [] })] });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    expect(
      await screen.findByText("No tools advertised. Start the server first."),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("tool-run-s1")).toBeNull();
  });

  it("rejects malformed JSON args without calling the tool", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    fireEvent.change(screen.getByTestId("tool-args-s1"), { target: { value: "{nope" } });
    fireEvent.click(screen.getByTestId("tool-run-s1"));
    const result = await screen.findByTestId("tool-result-s1");
    expect(result).toHaveTextContent(/Error · 0 ms/);
    expect(result).toHaveTextContent(/Invalid JSON args/);
    expect(testToolMock).not.toHaveBeenCalled();
  });

  it("runs the tool the user picked and shows a failed call as an error", async () => {
    testToolMock.mockRejectedValue(new Error("tool exploded"));
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    fireEvent.change(screen.getByTestId("tool-select-s1"), { target: { value: "write_file" } });
    fireEvent.change(screen.getByTestId("tool-args-s1"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("tool-run-s1"));
    const result = await screen.findByTestId("tool-result-s1");
    expect(testToolMock).toHaveBeenCalledExactlyOnceWith("s1", "write_file", {});
    expect(result).toHaveTextContent(/Error/);
    expect(result).toHaveTextContent("tool exploded");
  });

  it("turns per-call approval on for the server", async () => {
    setGovernanceMock.mockResolvedValue(makeServer({ requireApproval: true }));
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    await screen.findByText(/Filesystem/);
    fireEvent.click(screen.getByTestId("require-approval-s1"));
    await waitFor(() =>
      expect(setGovernanceMock).toHaveBeenCalledExactlyOnceWith("s1", { requireApproval: true }),
    );
  });

  it("lists schema drift by kind and approves the current snapshot", async () => {
    integrityDiffMock.mockResolvedValue({
      diff: { added: ["new_tool"], removed: ["old_tool"], changed: ["read_file"] },
      approvedAt: "2026-04-20T00:00:00Z",
      hasBaseline: true,
      version: "1.0.0",
      sha256: "a".repeat(64),
    });
    const approveMock = vi.mocked(mcpPlatformApi.approveSnapshot);
    approveMock.mockResolvedValue(undefined as never);
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    const drift = await screen.findByTestId("diff-changes");
    expect(drift).toHaveTextContent("added: new_tool");
    expect(drift).toHaveTextContent("removed: old_tool");
    expect(drift).toHaveTextContent("changed: read_file");
    expect(screen.getByTestId("integrity-s1")).toHaveTextContent(/approved /);
    fireEvent.click(screen.getByTestId("approve-snapshot-s1"));
    await waitFor(() => expect(approveMock).toHaveBeenCalledExactlyOnceWith("s1"));
  });

  it("omits a drift kind that has no entries", async () => {
    integrityDiffMock.mockResolvedValue({
      diff: { added: ["new_tool"], removed: [], changed: [] },
      approvedAt: null,
      hasBaseline: true,
      version: "1.0.0",
      sha256: "a".repeat(64),
    });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    const drift = await screen.findByTestId("diff-changes");
    expect(drift).toHaveTextContent("added: new_tool");
    expect(drift).not.toHaveTextContent("removed:");
    expect(drift).not.toHaveTextContent("changed:");
  });
});

describe("McpSettingsPage — Registry paging and search (#529)", () => {
  it("pages forward and back, and a new search returns to page 1", async () => {
    registryMock.mockResolvedValue({
      fetchedAt: "2026-04-25T00:00:00Z",
      stale: false,
      fromCache: false,
      total: 60,
      servers: [{ id: "fs", name: "Filesystem MCP", description: "x" }],
    });
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.mouseDown(screen.getByTestId("tab-registry"));
    expect(await screen.findByText(/Page 1 · 60 total/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(/Page 2 · 60 total/)).toBeInTheDocument();
    expect(registryMock).toHaveBeenLastCalledWith({ q: undefined, page: 2, pageSize: 25 });
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(await screen.findByText(/Page 1 · 60 total/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText(/Page 2 · 60 total/);
    fireEvent.change(screen.getByTestId("registry-search"), { target: { value: "git" } });
    expect(await screen.findByText(/Page 1 · 60 total/)).toBeInTheDocument();
    expect(registryMock).toHaveBeenLastCalledWith({ q: "git", page: 1, pageSize: 25 });
  });
});

describe("McpSettingsPage — Import / Export edge paths (#529)", () => {
  it("downloads the exported config as mcp.json", async () => {
    const exportMock = vi.mocked(mcpPlatformApi.exportJson);
    exportMock.mockResolvedValue({ servers: { fs: { command: "npx" } } } as never);
    const createUrl = vi.fn((_blob: Blob) => "blob:mcp");
    const revokeUrl = vi.fn();
    // jsdom has no object URLs; install stubs and put the originals back after.
    const { createObjectURL, revokeObjectURL } = URL;
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<McpSettingsPage />, { wrapper: makeWrapper() });
      fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
      fireEvent.click(screen.getByTestId("export-download"));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      const anchor = click.mock.instances[0] as unknown as HTMLAnchorElement;
      expect(anchor.download).toBe("mcp.json");
      expect(anchor.href).toBe("blob:mcp");
      const blob = createUrl.mock.calls[0]![0];
      expect(JSON.parse(await blob.text())).toEqual({ servers: { fs: { command: "npx" } } });
      expect(revokeUrl).toHaveBeenCalledWith("blob:mcp");
    } finally {
      click.mockRestore();
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  it("does not download anything when the export fails", async () => {
    vi.mocked(mcpPlatformApi.exportJson).mockRejectedValue(new Error("boom"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      render(<McpSettingsPage />, { wrapper: makeWrapper() });
      fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
      fireEvent.click(screen.getByTestId("export-download"));
      await waitFor(() => expect(error).toHaveBeenCalledWith("export failed", expect.any(Error)));
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
      error.mockRestore();
    }
  });

  it("rejects a JSON file with no top-level servers object", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.mouseDown(screen.getByTestId("tab-import-export"));
    const content = JSON.stringify({ mcpServers: {} });
    const file = new File([content], "mcp.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(content) });
    fireEvent.change(screen.getByTestId("import-file"), { target: { files: [file] } });
    expect(await screen.findByTestId("import-error")).toHaveTextContent(
      "Missing top-level `servers` object",
    );
    expect(screen.getByTestId("import-confirm")).toBeDisabled();
  });
});
