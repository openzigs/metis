/**
 * Epic #610 / Issue #625 — requirement-links API client tests.
 *
 * Verifies each wrapper builds the correct path / method / body / params against
 * the #624 endpoints. `apiFetch` itself is mocked (its unwrapping is tested in
 * api-client.test.ts); these assert the URL surface stays in lockstep.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({ apiFetch: vi.fn() }));

import { apiFetch } from "@/lib/api-client";
import { requirementLinksApi } from "@/lib/requirement-links-api";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({});
});

describe("requirementLinksApi", () => {
  it("lists a requirement's links", async () => {
    await requirementLinksApi.list("req-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/requirements/req-1/links");
  });

  it("creates a typed link", async () => {
    await requirementLinksApi.create("req-1", { targetRequirementId: "req-2", type: "depends_on" });
    expect(apiFetchMock).toHaveBeenCalledWith("/requirements/req-1/links", {
      method: "POST",
      body: { targetRequirementId: "req-2", type: "depends_on" },
    });
  });

  it("removes a link by id", async () => {
    await requirementLinksApi.remove("link-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/requirement-links/link-1", { method: "DELETE" });
  });

  it("searches workspace requirements with all params", async () => {
    await requirementLinksApi.search("ws-1", {
      q: "auth",
      excludeProject: "proj-1",
      page: 2,
      pageSize: 10,
    });
    expect(apiFetchMock).toHaveBeenCalledWith("/workspaces/ws-1/requirements/search", {
      params: { q: "auth", excludeProject: "proj-1", page: 2, pageSize: 10 },
    });
  });

  it("normalizes a blank query to undefined and defaults params", async () => {
    await requirementLinksApi.search("ws-1", { q: "" });
    expect(apiFetchMock).toHaveBeenCalledWith("/workspaces/ws-1/requirements/search", {
      params: { q: undefined, excludeProject: undefined, page: undefined, pageSize: undefined },
    });
  });

  it("searches with no params object", async () => {
    await requirementLinksApi.search("ws-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/workspaces/ws-1/requirements/search", {
      params: { q: undefined, excludeProject: undefined, page: undefined, pageSize: undefined },
    });
  });
});
