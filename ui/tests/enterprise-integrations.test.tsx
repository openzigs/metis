/**
 * Epic #163 — UI tests for enterprise integrations.
 *
 * Covers:
 *   - Library Connectors section (Confluence/Jira buttons + modal)
 *   - GitHub Projects v2 settings card
 *   - ACP settings page (token generation + reveal-once)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/enterprise-api", () => {
  const atlassianApi = {
    status: vi.fn(),
    ingestConfluence: vi.fn(),
    ingestJira: vi.fn(),
  };
  const acpApi = {
    listTokens: vi.fn(),
    createToken: vi.fn(),
    revokeToken: vi.fn(),
  };
  const projectsV2Api = {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    listBoards: vi.fn(),
  };
  return { atlassianApi, acpApi, projectsV2Api };
});

import { ConnectorsSection } from "@/components/library/connectors-section";
import { ProjectsV2SettingsCard } from "@/components/projects/projects-v2-settings-card";
import AcpSettingsPage from "@/app/(authed)/settings/acp/page";
import { atlassianApi, acpApi, projectsV2Api } from "@/lib/enterprise-api";

const atlassian = vi.mocked(atlassianApi);
const acp = vi.mocked(acpApi);
const pv2 = vi.mocked(projectsV2Api);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ConnectorsSection (#96)", () => {
  it("disables connector buttons when mcp-atlassian is not configured", async () => {
    atlassian.status.mockResolvedValue({ configured: false, serverId: null });
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(atlassian.status).toHaveBeenCalled());
    expect(screen.getByTestId("add-from-confluence")).toBeDisabled();
    expect(screen.getByTestId("add-from-jira")).toBeDisabled();
  });

  it("submits a Confluence ingest with space + query", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestConfluence.mockResolvedValue({
      ingested: 3,
      skipped: 0,
      failed: 0,
      documentIds: ["d1", "d2", "d3"],
    });
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("add-from-confluence")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("add-from-confluence"));
    fireEvent.change(screen.getByTestId("confluence-space-key"), {
      target: { value: "ENG" },
    });
    fireEvent.change(screen.getByTestId("confluence-query"), {
      target: { value: "label = api" },
    });
    fireEvent.click(screen.getByTestId("connector-submit"));
    await waitFor(() =>
      expect(atlassian.ingestConfluence).toHaveBeenCalledWith("p1", {
        spaceKey: "ENG",
        query: "label = api",
      }),
    );
    expect(await screen.findByTestId("connectors-last-summary")).toHaveTextContent(/Ingested 3/);
  });

  it("submits a Jira ingest with the provided JQL", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestJira.mockResolvedValue({
      ingested: 1,
      skipped: 0,
      failed: 0,
      documentIds: ["d1"],
    });
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("add-from-jira")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("add-from-jira"));
    fireEvent.change(screen.getByTestId("jira-jql"), {
      target: { value: 'project = "ENG"' },
    });
    fireEvent.click(screen.getByTestId("connector-submit"));
    await waitFor(() =>
      expect(atlassian.ingestJira).toHaveBeenCalledWith("p1", {
        jql: 'project = "ENG"',
      }),
    );
  });
});

describe("ProjectsV2SettingsCard (#108)", () => {
  it("loads boards and saves the selected board + field mapping", async () => {
    pv2.getSettings.mockResolvedValue({
      githubProjectId: null,
      fieldMappings: {},
    });
    pv2.listBoards.mockResolvedValue([
      { id: "PVT_1", number: 12, title: "v1.1 Roadmap", url: "https://gh/x/12" },
    ]);
    pv2.updateSettings.mockResolvedValue({
      githubProjectId: "PVT_1",
      fieldMappings: {},
    });
    render(<ProjectsV2SettingsCard projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(pv2.getSettings).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("pv2-secret"), {
      target: { value: "vault:pat" },
    });
    fireEvent.change(screen.getByTestId("pv2-owner"), {
      target: { value: "acme" },
    });
    fireEvent.click(screen.getByTestId("pv2-load-boards"));
    await waitFor(() => expect(screen.getByTestId("pv2-board-select")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("pv2-board-select"), {
      target: { value: "PVT_1" },
    });
    fireEvent.change(screen.getByTestId("pv2-status-id"), {
      target: { value: "PVTF_status" },
    });
    fireEvent.click(screen.getByTestId("pv2-save"));
    await waitFor(() => expect(pv2.updateSettings).toHaveBeenCalled());
    const args = pv2.updateSettings.mock.calls[0]?.[1];
    expect(args?.githubProjectId).toBe("PVT_1");
    expect(args?.fieldMappings?.Status?.fieldId).toBe("PVTF_status");
  });
});

describe("AcpSettingsPage (#119)", () => {
  it("generates a token and reveals it exactly once", async () => {
    acp.listTokens.mockResolvedValue([]);
    acp.createToken.mockResolvedValue({
      id: "t1",
      userId: "u1",
      name: "laptop",
      prefix: "metis_abc",
      scopes: ["acp:read"],
      createdAt: "",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
      token: "metis_supersecret",
    });
    render(<AcpSettingsPage />, { wrapper: makeWrapper() });
    await waitFor(() => expect(acp.listTokens).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId("acp-name"), {
      target: { value: "laptop" },
    });
    fireEvent.click(screen.getByTestId("acp-generate"));
    await waitFor(() =>
      expect(screen.getByTestId("acp-revealed-token")).toHaveTextContent("metis_supersecret"),
    );
    expect(screen.getByTestId("acp-mcp-snippet")).toHaveTextContent("metis_supersecret");
    expect(screen.getByTestId("acp-ws-url")).toHaveTextContent(/api\/acp/);
  });

  it("revokes an existing token", async () => {
    acp.listTokens.mockResolvedValue([
      {
        id: "t9",
        userId: "u1",
        name: "old",
        prefix: "metis_old",
        scopes: [],
        createdAt: "",
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      },
    ]);
    acp.revokeToken.mockResolvedValue({
      id: "t9",
      userId: "u1",
      name: "old",
      prefix: "metis_old",
      scopes: [],
      createdAt: "",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: new Date().toISOString(),
    });
    render(<AcpSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.click(await screen.findByTestId("acp-revoke-t9"));
    await waitFor(() => expect(acp.revokeToken).toHaveBeenCalledWith("t9"));
  });
});
