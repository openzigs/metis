/**
 * Coverage for the Phase 8 connector API wrappers (used by the new top-level
 * /repositories and /databases pages added in epic #196).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { repoConnectorsApi, dbConnectorsApi } from "@/lib/connectors-api";
import { apiFetch } from "@/lib/api-client";

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  vi.clearAllMocks();
  apiFetchMock.mockResolvedValue({} as never);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("repoConnectorsApi", () => {
  it("list / get / create / update / remove / test / metadata / ingest hit canonical paths", async () => {
    await repoConnectorsApi.list("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos");
    await repoConnectorsApi.get("p1", "r1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1");
    await repoConnectorsApi.create("p1", {
      label: "x",
      provider: "github",
      ownerOrOrg: "octo",
      repoName: "demo",
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos", {
      method: "POST",
      body: { label: "x", provider: "github", ownerOrOrg: "octo", repoName: "demo" },
    });
    await repoConnectorsApi.update("p1", "r1", { label: "y" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1", {
      method: "PATCH",
      body: { label: "y" },
    });
    await repoConnectorsApi.remove("p1", "r1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1", {
      method: "DELETE",
    });
    await repoConnectorsApi.test("p1", "r1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1/test", {
      method: "POST",
    });
    await repoConnectorsApi.metadata("p1", "r1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1/metadata", {
      method: "POST",
    });
    await repoConnectorsApi.ingest("p1", "r1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/repos/r1/ingest", {
      method: "POST",
    });
  });
});

describe("dbConnectorsApi", () => {
  it("list / get / create / update / remove / test / inspect / query / ingest hit canonical paths", async () => {
    await dbConnectorsApi.list("p1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs");
    await dbConnectorsApi.get("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1");
    await dbConnectorsApi.create("p1", {
      label: "primary",
      driver: "postgres",
      host: "h",
      port: 5432,
      databaseName: "metis",
      username: "u",
    });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs", {
      method: "POST",
      body: {
        label: "primary",
        driver: "postgres",
        host: "h",
        port: 5432,
        databaseName: "metis",
        username: "u",
      },
    });
    await dbConnectorsApi.update("p1", "d1", { label: "renamed" });
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1", {
      method: "PATCH",
      body: { label: "renamed" },
    });
    await dbConnectorsApi.remove("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1", {
      method: "DELETE",
    });
    await dbConnectorsApi.test("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/test", {
      method: "POST",
    });
    await dbConnectorsApi.inspect("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/inspect", {
      method: "POST",
      body: {},
    });
    await dbConnectorsApi.inspect("p1", "d1", "public");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/inspect", {
      method: "POST",
      body: { schema: "public" },
    });
    await dbConnectorsApi.query("p1", "d1", "SELECT 1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/query", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    await dbConnectorsApi.ingest("p1", "d1");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/ingest", {
      method: "POST",
      body: {},
    });
    await dbConnectorsApi.ingest("p1", "d1", "warehouse");
    expect(apiFetchMock).toHaveBeenLastCalledWith("/projects/p1/connectors/dbs/d1/ingest", {
      method: "POST",
      body: { schema: "warehouse" },
    });
  });
});
