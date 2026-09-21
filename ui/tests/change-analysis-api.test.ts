/**
 * Tests for change analysis API client — Epic #557.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the api-client module
const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import { changeAnalysisApi, publishDestinationApi } from "@/lib/change-analysis-api";

beforeEach(() => vi.clearAllMocks());

describe("changeAnalysisApi", () => {
  it("trigger calls POST with correct path and body", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "ca_1" });

    await changeAnalysisApi.trigger("proj_1", {
      baseAnalysisId: "a1",
      headAnalysisId: "a2",
    });

    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_1/change-analyses", {
      method: "POST",
      body: { baseAnalysisId: "a1", headAnalysisId: "a2" },
    });
  });

  it("list calls GET with correct path", async () => {
    mockApiFetch.mockResolvedValueOnce([]);

    await changeAnalysisApi.list("proj_1");

    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_1/change-analyses");
  });

  it("get calls GET with correct path", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "ca_1", changes: [] });

    await changeAnalysisApi.get("proj_1", "ca_1");

    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_1/change-analyses/ca_1");
  });

  it("reviewChange calls POST with correct path and body", async () => {
    mockApiFetch.mockResolvedValueOnce({ id: "rc_1", reviewStatus: "approved" });

    await changeAnalysisApi.reviewChange("proj_1", "ca_1", "rc_1", {
      reviewStatus: "approved",
    });

    expect(mockApiFetch).toHaveBeenCalledWith(
      "/projects/proj_1/change-analyses/ca_1/changes/rc_1/review",
      { method: "POST", body: { reviewStatus: "approved" } },
    );
  });
});

describe("publishDestinationApi", () => {
  it("get calls GET with correct path", async () => {
    mockApiFetch.mockResolvedValueOnce({ publishDestination: "github" });

    await publishDestinationApi.get("proj_1");

    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_1/publish-destination");
  });

  it("update calls PATCH with correct path and body", async () => {
    mockApiFetch.mockResolvedValueOnce({ publishDestination: "both" });

    await publishDestinationApi.update("proj_1", {
      publishDestination: "both",
      jiraProjectKey: "PROJ",
      jiraConnectionId: "conn_1",
    });

    expect(mockApiFetch).toHaveBeenCalledWith("/projects/proj_1/publish-destination", {
      method: "PATCH",
      body: {
        publishDestination: "both",
        jiraProjectKey: "PROJ",
        jiraConnectionId: "conn_1",
      },
    });
  });
});
