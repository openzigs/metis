/**
 * Tests for sync-api.ts — verifies correct URL construction and payload shapes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchDriftEvents, fetchDriftCount, resolveDrift } from "@/lib/sync-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("sync-api", () => {
  describe("fetchDriftEvents", () => {
    it("calls /sync/drift with projectId param", async () => {
      apiFetchMock.mockResolvedValue({ items: [], total: 0 });
      const result = await fetchDriftEvents("proj-1");
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift", {
        params: {
          projectId: "proj-1",
          status: undefined,
          requirementId: undefined,
          page: undefined,
          perPage: undefined,
        },
      });
      expect(result).toEqual({ items: [], total: 0 });
    });

    it("passes optional filters", async () => {
      apiFetchMock.mockResolvedValue({ items: [], total: 5 });
      await fetchDriftEvents("proj-2", {
        status: "pending",
        requirementId: "req-1",
        page: 2,
        perPage: 10,
      });
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift", {
        params: {
          projectId: "proj-2",
          status: "pending",
          requirementId: "req-1",
          page: 2,
          perPage: 10,
        },
      });
    });
  });

  describe("fetchDriftCount", () => {
    it("returns count from response", async () => {
      apiFetchMock.mockResolvedValue({ count: 7 });
      const count = await fetchDriftCount("proj-3");
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift/count", {
        params: { projectId: "proj-3" },
      });
      expect(count).toBe(7);
    });
  });

  describe("resolveDrift", () => {
    it("posts resolve with adopt action", async () => {
      apiFetchMock.mockResolvedValue({ id: "d-1", status: "resolved" });
      await resolveDrift("d-1", "adopt");
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift/d-1/resolve", {
        method: "POST",
        body: { action: "adopt" },
      });
    });

    it("posts resolve with push action", async () => {
      apiFetchMock.mockResolvedValue({ id: "d-2", status: "resolved" });
      await resolveDrift("d-2", "push");
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift/d-2/resolve", {
        method: "POST",
        body: { action: "push" },
      });
    });

    it("posts resolve with divergent action", async () => {
      apiFetchMock.mockResolvedValue({ id: "d-3", status: "resolved" });
      await resolveDrift("d-3", "divergent");
      expect(apiFetchMock).toHaveBeenCalledWith("/sync/drift/d-3/resolve", {
        method: "POST",
        body: { action: "divergent" },
      });
    });
  });
});
