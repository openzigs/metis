import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import McpSettingsPage from "@/app/(authed)/settings/mcp/page";
import { mcpApi, mcpPlatformApi, type MCPServerView, type McpFederationEntry } from "@/lib/mcp-api";

vi.mock("@/lib/mcp-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/mcp-api")>("@/lib/mcp-api");
  return {
    ...actual,
    mcpApi: { ...actual.mcpApi, list: vi.fn() },
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
      searchFederated: vi.fn(),
      refreshFederation: vi.fn(),
      installFederated: vi.fn(),
    },
  };
});

const listMock = vi.mocked(mcpApi.list);
const searchMock = vi.mocked(mcpPlatformApi.searchFederated);
const installFederatedMock = vi.mocked(mcpPlatformApi.installFederated);

const SAMPLE_ENTRIES: McpFederationEntry[] = [
  {
    id: "e1",
    source: "smithery",
    externalId: "smithery:fs",
    name: "Filesystem",
    description: "Read/write files",
    publisher: "smithery-co",
    version: "2.0.0",
    downloads: 1234,
    stars: 42,
    lastUpdated: "2026-04-20T00:00:00Z",
    sha256: "a".repeat(64),
    manifest: { transport: "stdio", command: "fs-mcp" },
    metadata: { source: "smithery" },
    fetchedAt: "2026-04-26T00:00:00Z",
  },
  {
    id: "e2",
    source: "official",
    externalId: "official:github",
    name: "GitHub MCP",
    description: "GitHub API tools",
    publisher: "github",
    version: "1.0.0",
    downloads: null,
    stars: null,
    lastUpdated: null,
    sha256: null,
    manifest: { transport: "stdio", command: "gh-mcp" },
    metadata: {},
    fetchedAt: "2026-04-26T00:00:00Z",
  },
];

const FAKE_INSTALLED: MCPServerView = {
  id: "s2",
  scope: "global",
  projectId: null,
  label: "Filesystem",
  transport: "stdio",
  runtime: "native",
  command: "fs-mcp",
  args: null,
  url: null,
  headers: null,
  env: null,
  envSecretRefs: null,
  enabled: true,
  trustLevel: "untrusted",
  defaultToolRisk: "medium",
  version: "2.0.0",
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
  capabilities: [],
  createdAt: "2026-04-26T00:00:00Z",
  updatedAt: "2026-04-26T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  listMock.mockResolvedValue({ items: [] });
  searchMock.mockResolvedValue({ total: SAMPLE_ENTRIES.length, entries: SAMPLE_ENTRIES });
});

describe("MCP Federated tab", () => {
  it("renders entries with source badges and metadata", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    fireEvent.click(screen.getByRole("tab", { name: /federated/i }));
    await waitFor(() => expect(searchMock).toHaveBeenCalled());

    const entries = await screen.findAllByTestId("federation-entry");
    expect(entries).toHaveLength(2);
    expect(screen.getByText("Filesystem")).toBeInTheDocument();
    expect(screen.getByText("GitHub MCP")).toBeInTheDocument();
    const badges = screen.getAllByTestId("source-badge");
    expect(badges.map((b) => b.textContent)).toEqual(["smithery", "official"]);
    expect(screen.getByText(/1,234/)).toBeInTheDocument();
  });

  it("admin install button calls installFederated and refreshes", async () => {
    installFederatedMock.mockResolvedValue(FAKE_INSTALLED);
    render(<McpSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    fireEvent.click(screen.getByRole("tab", { name: /federated/i }));
    await screen.findAllByTestId("federation-entry");

    const installBtn = screen.getAllByTestId("install-button")[0]!;
    expect(installBtn).not.toBeDisabled();
    fireEvent.click(installBtn);
    await waitFor(() => expect(installFederatedMock).toHaveBeenCalledWith({ entryId: "e1" }));
  });

  it("non-admin sees install buttons disabled and the warning", async () => {
    render(<McpSettingsPage />, {
      wrapper: makeWrapper({ initialUser: { ...TEST_USER, role: "reader" } }),
    });
    fireEvent.click(screen.getByRole("tab", { name: /federated/i }));
    await screen.findAllByTestId("federation-entry");

    expect(screen.getByText(/admin approval/i)).toBeInTheDocument();
    for (const btn of screen.getAllByTestId("install-button")) {
      expect(btn).toBeDisabled();
    }
  });

  it("source filter passes through to the API", async () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    fireEvent.click(screen.getByRole("tab", { name: /federated/i }));
    await waitFor(() => expect(searchMock).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText(/source filter/i), {
      target: { value: "smithery" },
    });
    await waitFor(() =>
      expect(searchMock).toHaveBeenLastCalledWith({
        q: undefined,
        source: "smithery",
        pageSize: 50,
      }),
    );
  });

  it("renders empty state when no entries match", async () => {
    searchMock.mockResolvedValue({ total: 0, entries: [] });
    render(<McpSettingsPage />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    fireEvent.click(screen.getByRole("tab", { name: /federated/i }));
    await waitFor(() => expect(searchMock).toHaveBeenCalled());
    expect(await screen.findByText(/No matching servers/i)).toBeInTheDocument();
  });
});
