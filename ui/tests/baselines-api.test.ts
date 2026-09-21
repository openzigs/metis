/**
 * Epic #609 / Issue #620 — baselines API client tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";
import { baselinesApi } from "@/lib/baselines-api";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({});
});

describe("baselinesApi", () => {
  it("lists project baselines with pagination", async () => {
    await baselinesApi.list("proj-1", 2, 25);
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/baselines", {
      params: { page: 2, pageSize: 25 },
    });
  });

  it("lists with default pagination", async () => {
    await baselinesApi.list("proj-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/baselines", {
      params: { page: undefined, pageSize: undefined },
    });
  });

  it("fetches baseline contents by id", async () => {
    await baselinesApi.get("base-1");
    expect(apiFetchMock).toHaveBeenCalledWith("/baselines/base-1");
  });

  it("compares two baselines A → B", async () => {
    await baselinesApi.compare("base-1", "base-2");
    expect(apiFetchMock).toHaveBeenCalledWith("/baselines/base-1/compare/base-2");
  });

  it("creates a manual baseline", async () => {
    await baselinesApi.create("proj-1", { name: "Q3 freeze", requirementIds: ["req-1"] });
    expect(apiFetchMock).toHaveBeenCalledWith("/projects/proj-1/baselines", {
      method: "POST",
      body: { name: "Q3 freeze", requirementIds: ["req-1"] },
    });
  });

  it("exposes no update or delete calls (baselines are immutable)", () => {
    const surface = Object.keys(baselinesApi).sort();
    expect(surface).toEqual(["compare", "create", "get", "list"]);
  });
});
