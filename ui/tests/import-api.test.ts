/**
 * Import API client unit tests — Epic #776 (#783 / #784).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

import { importApi } from "../src/lib/import-api";

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => vi.clearAllMocks());

describe("importApi", () => {
  it("preview posts /projects/:id/imports/preview", async () => {
    await importApi.preview("p1", { source: "github", filter: { owner: "o", repo: "r" } });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/preview", {
      method: "POST",
      body: { source: "github", filter: { owner: "o", repo: "r" } },
    });
  });

  it("listSources hits /projects/:id/imports/sources", async () => {
    await importApi.listSources("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources");
  });

  it("getSource hits /projects/:id/imports/sources/:sid", async () => {
    await importApi.getSource("p1", "s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources/s1");
  });

  it("createSource posts to /projects/:id/imports/sources", async () => {
    await importApi.createSource("p1", {
      source: "linear",
      label: "L",
      filter: { teamId: "t1", includeArchived: false },
      token: "tok",
      syncEnabled: false,
      syncIntervalMinutes: 15,
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources", {
      method: "POST",
      body: {
        source: "linear",
        label: "L",
        filter: { teamId: "t1", includeArchived: false },
        token: "tok",
        syncEnabled: false,
        syncIntervalMinutes: 15,
      },
    });
  });

  it("runSource posts /projects/:id/imports/sources/:sid/run", async () => {
    await importApi.runSource("p1", "s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources/s1/run", {
      method: "POST",
    });
  });

  it("setSync patches /projects/:id/imports/sources/:sid/sync", async () => {
    await importApi.setSync("p1", "s1", { syncEnabled: true, syncIntervalMinutes: 30 });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources/s1/sync", {
      method: "PATCH",
      body: { syncEnabled: true, syncIntervalMinutes: 30 },
    });
  });

  it("deleteSource deletes /projects/:id/imports/sources/:sid", async () => {
    await importApi.deleteSource("p1", "s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/sources/s1", {
      method: "DELETE",
    });
  });

  it("listRuns without sourceId omits params", async () => {
    await importApi.listRuns("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/runs", {
      params: undefined,
    });
  });

  it("listRuns with sourceId passes it as a query param", async () => {
    await importApi.listRuns("p1", "s1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/imports/runs", {
      params: { sourceId: "s1" },
    });
  });

  it("URL-encodes path segments", async () => {
    await importApi.getSource("p 1", "s/1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p%201/imports/sources/s%2F1");
  });
});
