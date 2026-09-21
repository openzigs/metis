/**
 * Issue #121 extended — quick-win API tests for enterprise-api.ts, settings-api.ts,
 * and projects-api.ts uncovered functions/branches.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
const mock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mock.mockReset();
});

// ─── enterprise-api ───────────────────────────────────────────────────────────

import { atlassianApi, acpApi, projectsV2Api } from "@/lib/enterprise-api";

describe("atlassianApi", () => {
  it("status calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ configured: false, serverId: null });
    await atlassianApi.status("p1");
    expect(mock).toHaveBeenCalledWith("/projects/p1/connectors/atlassian/status");
  });

  it("ingestConfluence calls POST", async () => {
    mock.mockResolvedValueOnce({ ingested: 5, skipped: 0, failed: 0, documentIds: [] });
    await atlassianApi.ingestConfluence("p1", { spaceKey: "ENG" });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("confluence/ingest"),
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("ingestJira calls POST", async () => {
    mock.mockResolvedValueOnce({ ingested: 3, skipped: 1, failed: 0, documentIds: [] });
    await atlassianApi.ingestJira("p1", { jql: "project=ENG" });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("jira/ingest"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("acpApi", () => {
  it("listTokens calls correct endpoint", async () => {
    mock.mockResolvedValueOnce([]);
    await acpApi.listTokens();
    expect(mock).toHaveBeenCalledWith("/acp/tokens");
  });

  it("createToken calls POST", async () => {
    mock.mockResolvedValueOnce({ id: "t1", token: "secret" });
    await acpApi.createToken({ name: "My Token" });
    expect(mock).toHaveBeenCalledWith("/acp/tokens", expect.objectContaining({ method: "POST" }));
  });

  it("revokeToken calls DELETE", async () => {
    mock.mockResolvedValueOnce({ id: "t1" });
    await acpApi.revokeToken("t1");
    expect(mock).toHaveBeenCalledWith(
      "/acp/tokens/t1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

describe("projectsV2Api", () => {
  it("getSettings calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ githubProjectId: null, fieldMappings: {} });
    await projectsV2Api.getSettings("p1");
    expect(mock).toHaveBeenCalledWith(expect.stringContaining("projects-v2-settings"));
  });

  it("updateSettings calls PUT", async () => {
    mock.mockResolvedValueOnce({ githubProjectId: "1", fieldMappings: {} });
    await projectsV2Api.updateSettings("p1", { githubProjectId: "1", fieldMappings: null });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("projects-v2-settings"),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("listBoards calls POST", async () => {
    mock.mockResolvedValueOnce([]);
    await projectsV2Api.listBoards("p1", { secretRef: "${vault:gh}", targetOwner: "acme" });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("projects-v2-boards"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});

// ─── settings-api ─────────────────────────────────────────────────────────────

import { settingsApi, configApi } from "@/lib/settings-api";

describe("settingsApi — uncovered functions", () => {
  it("envVars calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ items: [] });
    await settingsApi.envVars();
    expect(mock).toHaveBeenCalledWith("/settings/env");
  });
});

describe("configApi — uncovered functions", () => {
  it("list calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ items: [] });
    await configApi.list();
    expect(mock).toHaveBeenCalledWith("/admin/config");
  });

  it("get calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ key: "SOME_KEY" });
    await configApi.get("SOME_KEY");
    expect(mock).toHaveBeenCalledWith(expect.stringContaining("SOME_KEY"));
  });

  it("set calls PUT", async () => {
    mock.mockResolvedValueOnce({ key: "SOME_KEY" });
    await configApi.set("SOME_KEY", "value");
    expect(mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("clear calls DELETE", async () => {
    mock.mockResolvedValueOnce({ key: "SOME_KEY" });
    await configApi.clear("SOME_KEY");
    expect(mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("audit calls correct endpoint with no params", async () => {
    mock.mockResolvedValueOnce({ items: [], nextCursor: null });
    await configApi.audit();
    expect(mock).toHaveBeenCalledWith(expect.stringContaining("audit"), expect.anything());
  });

  it("setSecret calls PUT", async () => {
    mock.mockResolvedValueOnce({ key: "SECRET" });
    await configApi.setSecret("SECRET", "value123");
    expect(mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "PUT" }),
    );
  });

  it("clearSecret calls DELETE", async () => {
    mock.mockResolvedValueOnce({ key: "SECRET" });
    await configApi.clearSecret("SECRET");
    expect(mock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});

// ─── projects-api uncovered functions ────────────────────────────────────────

import { projectsApi } from "@/lib/projects-api";

describe("projectsApi — uncovered functions", () => {
  it("updateAllowCredentialScan calls PATCH", async () => {
    mock.mockResolvedValueOnce({ allowCredentialScan: true });
    await projectsApi.updateAllowCredentialScan("p1", { allowCredentialScan: true });
    expect(mock).toHaveBeenCalledWith(
      expect.stringContaining("p1"),
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("get calls correct endpoint", async () => {
    mock.mockResolvedValueOnce({ id: "p1", name: "My Project" });
    await projectsApi.get("p1");
    expect(mock).toHaveBeenCalledWith(expect.stringContaining("p1"));
  });
});
