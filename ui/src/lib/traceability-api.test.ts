/**
 * Unit tests for the traceability API client — Epic #610 (#626).
 *
 * Asserts the new workspace-rollup wrappers build the right URL + query params
 * (`apiFetch` mocked) so the UI stays in lockstep with the server routes.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));

const { traceabilityApi } = await import("./traceability-api");

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ ok: true });
});

describe("traceabilityApi.workspaceSummary", () => {
  it("GETs the workspace summary endpoint", async () => {
    await traceabilityApi.workspaceSummary("ws-1");
    expect(apiFetch).toHaveBeenCalledWith("/workspaces/ws-1/traceability/summary");
  });
});

describe("traceabilityApi.chainWithLinks", () => {
  it("requests the chain with includeLinked + default depth 1", async () => {
    await traceabilityApi.chainWithLinks("proj-1", "req-1");
    expect(apiFetch).toHaveBeenCalledWith("/projects/proj-1/requirements/req-1/traceability", {
      params: { includeLinked: "true", depth: "1" },
    });
  });

  it("threads an explicit depth", async () => {
    await traceabilityApi.chainWithLinks("proj-1", "req-1", 3);
    expect(apiFetch).toHaveBeenCalledWith("/projects/proj-1/requirements/req-1/traceability", {
      params: { includeLinked: "true", depth: "3" },
    });
  });
});
