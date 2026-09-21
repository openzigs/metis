/**
 * Jira API client unit tests — Epic #556.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

import { jiraApi } from "../src/lib/jira-api";

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => vi.clearAllMocks());

describe("jiraApi", () => {
  it("list hits /jira/connections?projectId=X", async () => {
    await jiraApi.list("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections?projectId=p1");
  });

  it("get hits /jira/connections/:id", async () => {
    await jiraApi.get("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1");
  });

  it("create posts with projectId in body", async () => {
    await jiraApi.create("p1", {
      label: "test",
      edition: "cloud",
      baseUrl: "https://x.atlassian.net",
      username: "u",
      apiToken: "t",
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections", {
      method: "POST",
      body: {
        projectId: "p1",
        label: "test",
        edition: "cloud",
        baseUrl: "https://x.atlassian.net",
        username: "u",
        apiToken: "t",
      },
    });
  });

  it("update patches /jira/connections/:id", async () => {
    await jiraApi.update("j1", { label: "renamed" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1", {
      method: "PATCH",
      body: { label: "renamed" },
    });
  });

  it("remove deletes /jira/connections/:id", async () => {
    await jiraApi.remove("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1", { method: "DELETE" });
  });

  it("test posts /jira/connections/:id/test", async () => {
    await jiraApi.test("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1/test", { method: "POST" });
  });

  it("listProjects hits /jira/connections/:id/projects", async () => {
    await jiraApi.listProjects("j1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1/projects");
  });

  it("search posts /jira/connections/:id/search", async () => {
    await jiraApi.search("j1", { jql: "project=X", startAt: 0, maxResults: 20 });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1/search", {
      method: "POST",
      body: { jql: "project=X", startAt: 0, maxResults: 20 },
    });
  });

  it("getIssue hits /jira/connections/:id/issues/:key", async () => {
    await jiraApi.getIssue("j1", "PROJ-1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/jira/connections/j1/issues/PROJ-1");
  });
});
