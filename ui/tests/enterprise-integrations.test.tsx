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
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";
import { expectAccessibleModal } from "./a11y/modal-dialog";

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
import {
  atlassianApi,
  acpApi,
  projectsV2Api,
  type AtlassianIngestSummary,
} from "@/lib/enterprise-api";

const atlassian = vi.mocked(atlassianApi);
const acp = vi.mocked(acpApi);
const pv2 = vi.mocked(projectsV2Api);

beforeEach(() => {
  vi.clearAllMocks();
});

/** The server's ingest summary shape (`server/src/lib/connectors/atlassian.ts`). */
function summary(over: Partial<AtlassianIngestSummary>): AtlassianIngestSummary {
  return {
    documentsCreated: 0,
    documentsUpdated: 0,
    chunkCount: 0,
    failures: 0,
    skipped: 0,
    found: 0,
    omitted: 0,
    limit: 200,
    ...over,
  };
}

describe("ConnectorsSection (#96)", () => {
  it("the ingest modal is an accessible dialog (#268)", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    const user = userEvent.setup();
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    const opener = screen.getByTestId("add-from-jira");
    await waitFor(() => expect(opener).not.toBeDisabled());
    await user.click(opener);
    await expectAccessibleModal(user, "Ingest a Jira query", opener);
  });

  it("disables connector buttons when mcp-atlassian is not configured", async () => {
    atlassian.status.mockResolvedValue({ configured: false, serverId: null });
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(atlassian.status).toHaveBeenCalled());
    expect(screen.getByTestId("add-from-confluence")).toBeDisabled();
    expect(screen.getByTestId("add-from-jira")).toBeDisabled();
  });

  it("submits a Confluence ingest with space + query", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestConfluence.mockResolvedValue(
      summary({ documentsCreated: 3, found: 3, limit: 200 }),
    );
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
    expect(await screen.findByTestId("connectors-last-summary")).toHaveTextContent(
      "Ingested 3 new · updated 0 · unchanged 0 · failed 0",
    );
    expect(screen.queryByTestId("connectors-last-omitted")).not.toBeInTheDocument();
  });

  it("#2244: tells the analyst how many pages the per-run cap left out", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestConfluence.mockResolvedValue(
      summary({ documentsCreated: 200, found: 260, omitted: 60, limit: 200 }),
    );
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("add-from-confluence")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("add-from-confluence"));
    fireEvent.change(screen.getByTestId("confluence-space-key"), { target: { value: "ENG" } });
    fireEvent.click(screen.getByTestId("connector-submit"));
    expect(await screen.findByTestId("connectors-last-omitted")).toHaveTextContent(
      "60 of 260 matching pages were not ingested. One run ingests at most 200 pages.",
    );
  });

  it("#2244: names a search that returned fewer issues than it matched", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestJira.mockResolvedValue(
      summary({ documentsCreated: 50, found: 640, omitted: 590, limit: 500 }),
    );
    render(<ConnectorsSection projectId="p1" />, { wrapper: makeWrapper() });
    await waitFor(() => expect(screen.getByTestId("add-from-jira")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("add-from-jira"));
    fireEvent.change(screen.getByTestId("jira-jql"), { target: { value: "project = ENG" } });
    // #2260 — the status region is mounted, empty, before the run, so the note is announced.
    const region = screen.getByTestId("connectors-last-omitted-region");
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();
    fireEvent.click(screen.getByTestId("connector-submit"));
    const note = await screen.findByTestId("connectors-last-omitted");
    expect(note).toHaveTextContent(
      "590 of 640 matching issues were not ingested. The search returned only 50.",
    );
    expect(screen.getByTestId("connectors-last-omitted-region")).toBe(region);
    expect(region).toContainElement(note);
  });

  it("submits a Jira ingest with the provided JQL", async () => {
    atlassian.status.mockResolvedValue({ configured: true, serverId: "srv-1" });
    atlassian.ingestJira.mockResolvedValue(summary({ documentsCreated: 1, found: 1, limit: 500 }));
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
