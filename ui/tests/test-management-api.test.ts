/**
 * test-management API client unit tests — Issue #871 UI follow-up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

import { testManagementApi } from "../src/lib/test-management-api";

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => vi.clearAllMocks());

describe("testManagementApi", () => {
  it("list hits /test-management/connections?projectId=X", async () => {
    await testManagementApi.list("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections?projectId=p1");
  });

  it("list URL-encodes weird projectIds", async () => {
    await testManagementApi.list("p/1 with spaces");
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      "/test-management/connections?projectId=p%2F1%20with%20spaces",
    );
  });

  it("get hits /test-management/connections/:id", async () => {
    await testManagementApi.get("c1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections/c1");
  });

  it("create POSTs to projectId-qualified endpoint with body", async () => {
    await testManagementApi.create("p1", {
      label: "Prod TestRail",
      kind: "testrail",
      baseUrl: "https://example.testrail.io",
      auth: { kind: "testrail", email: "u@x.com", apiKey: "k" },
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections?projectId=p1", {
      method: "POST",
      body: {
        label: "Prod TestRail",
        kind: "testrail",
        baseUrl: "https://example.testrail.io",
        auth: { kind: "testrail", email: "u@x.com", apiKey: "k" },
      },
    });
  });

  it("update PATCHes /test-management/connections/:id", async () => {
    await testManagementApi.update("c1", { label: "Renamed" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections/c1", {
      method: "PATCH",
      body: { label: "Renamed" },
    });
  });

  it("remove DELETEs /test-management/connections/:id", async () => {
    await testManagementApi.remove("c1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections/c1", {
      method: "DELETE",
    });
  });

  it("test POSTs to /test-management/connections/:id/test", async () => {
    await testManagementApi.test("c1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/test-management/connections/c1/test", {
      method: "POST",
    });
  });
});
