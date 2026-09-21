/**
 * Tests for the cross-project impact API client — Epic #295 Phase 4 (#309/#310).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockApiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => mockApiFetch(...args),
}));

import {
  crossProjectUsageByObject,
  fetchCrossProjectImpact,
  fetchProjectsUsingObject,
} from "@/lib/cross-project-api";
import type { CrossProjectImpactResult, ProjectObjectUsage } from "@metis/shared";

beforeEach(() => vi.clearAllMocks());

describe("fetchProjectsUsingObject", () => {
  it("GETs the workspace object-usage endpoint with query params", async () => {
    mockApiFetch.mockResolvedValueOnce({ identity: {}, projects: [], rollupUsageClass: "used" });
    await fetchProjectsUsingObject({
      workspaceId: "ws-1",
      objectName: "orders",
      schemaName: "public",
      objectType: "table",
    });
    expect(mockApiFetch).toHaveBeenCalledWith("/impact-analyses/workspaces/ws-1/objects/usage", {
      params: { objectName: "orders", schemaName: "public", objectType: "table" },
    });
  });

  it("omits optional params when not provided (undefined)", async () => {
    mockApiFetch.mockResolvedValueOnce({
      identity: {},
      projects: [],
      rollupUsageClass: "unreferenced",
    });
    await fetchProjectsUsingObject({ workspaceId: "ws-1", objectName: "audit_log" });
    expect(mockApiFetch).toHaveBeenCalledWith("/impact-analyses/workspaces/ws-1/objects/usage", {
      params: { objectName: "audit_log", schemaName: undefined, objectType: undefined },
    });
  });

  it("url-encodes the workspace id", async () => {
    mockApiFetch.mockResolvedValueOnce({});
    await fetchProjectsUsingObject({ workspaceId: "ws/with space", objectName: "x" });
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/impact-analyses/workspaces/ws%2Fwith%20space/objects/usage",
      expect.anything(),
    );
  });
});

describe("fetchCrossProjectImpact", () => {
  it("GETs the project cross-project-impact endpoint", async () => {
    mockApiFetch.mockResolvedValueOnce({
      sourceProjectId: "p1",
      workspaceId: "ws",
      affectedObjects: [],
    });
    const res = await fetchCrossProjectImpact("p1");
    expect(mockApiFetch).toHaveBeenCalledWith("/impact-analyses/projects/p1/cross-project-impact");
    expect(res.sourceProjectId).toBe("p1");
  });

  it("url-encodes the project id", async () => {
    mockApiFetch.mockResolvedValueOnce({});
    await fetchCrossProjectImpact("p/1");
    expect(mockApiFetch).toHaveBeenCalledWith(
      "/impact-analyses/projects/p%2F1/cross-project-impact",
    );
  });
});

describe("crossProjectUsageByObject", () => {
  function proj(over: Partial<ProjectObjectUsage> = {}): ProjectObjectUsage {
    return { projectId: "p2", projectName: "Beta", usageClass: "used", evidenceCount: 1, ...over };
  }
  function result(
    affectedObjects: CrossProjectImpactResult["affectedObjects"],
  ): CrossProjectImpactResult {
    return { sourceProjectId: "p1", workspaceId: "ws", affectedObjects };
  }

  it("returns an empty map for null/undefined input", () => {
    expect(crossProjectUsageByObject(null)).toEqual({});
    expect(crossProjectUsageByObject(undefined)).toEqual({});
  });

  it("keys schema-qualified objects as `<schema>.<object>`", () => {
    const map = crossProjectUsageByObject(
      result([
        {
          objectName: "orders",
          schemaName: "public",
          objectType: "table",
          alsoUsedByProjects: [proj()],
        },
      ]),
    );
    expect(Object.keys(map)).toEqual(["public.orders"]);
    expect(map["public.orders"]).toHaveLength(1);
  });

  it("keys bare (no-schema) objects by the object name only", () => {
    const map = crossProjectUsageByObject(
      result([
        {
          objectName: "audit_log",
          schemaName: null,
          objectType: "table",
          alsoUsedByProjects: [proj()],
        },
      ]),
    );
    expect(map).toHaveProperty("audit_log");
  });

  it("omits objects with no sibling projects (only surfaces shared objects)", () => {
    const map = crossProjectUsageByObject(
      result([
        { objectName: "lonely", schemaName: null, objectType: "table", alsoUsedByProjects: [] },
        {
          objectName: "shared",
          schemaName: "public",
          objectType: "table",
          alsoUsedByProjects: [proj()],
        },
      ]),
    );
    expect(map).not.toHaveProperty("lonely");
    expect(map).toHaveProperty("public.shared");
  });
});
