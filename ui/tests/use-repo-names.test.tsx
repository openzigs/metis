/**
 * Issue #23 — the Analysis document picker and the Workbench labelled repo
 * files with the last six characters of the connector id. `useRepoNames`
 * resolves each connector id to the repository's name.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/connectors-api", () => ({ repoConnectorsApi: { list: vi.fn() } }));

import { repoConnectorsApi } from "@/lib/connectors-api";
import { repoNamesById, useRepoNames, useRepoNamesForProjects } from "@/hooks/use-repo-names";

const list = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  list.mockReset();
});

describe("repoNamesById", () => {
  it("maps each connector id to its repository name, else its label", () => {
    expect(
      repoNamesById([
        { id: "c1", repoName: "metis", label: "Metis (main)" },
        { id: "c2", repoName: null, label: "Local checkout" },
        { id: "c3", repoName: "  ", label: "Upload" },
      ]),
    ).toEqual({ c1: "metis", c2: "Local checkout", c3: "Upload" });
  });

  it("returns an empty map for no connectors", () => {
    expect(repoNamesById(undefined)).toEqual({});
    expect(repoNamesById([])).toEqual({});
  });

  it("returns an empty map for a non-array payload instead of throwing", () => {
    expect(repoNamesById({})).toEqual({});
    expect(repoNamesById({ items: [{ id: "c1", label: "x" }] })).toEqual({});
  });
});

describe("repoNamesById — malformed elements", () => {
  // #23 review — the Array.isArray guard promised "never throws", but a null
  // element threw on `c.id`.
  it("skips null and id-less elements instead of throwing", () => {
    expect(
      repoNamesById([
        null,
        7,
        { label: "no id" },
        { id: "c1", repoName: "metis", label: "x" },
        { id: "c2" },
      ]),
    ).toEqual({ c1: "metis", c2: "c2" });
  });
});

describe("useRepoNames", () => {
  it("loads the project's repo connectors and returns the id → name map", async () => {
    list.mockResolvedValue([{ id: "c1", repoName: "metis", label: "x" }]);
    const { result } = renderHook(() => useRepoNames("proj-1"), {
      wrapper: makeWrapper({ withAuth: false }),
    });
    await waitFor(() => expect(result.current).toEqual({ c1: "metis" }));
    expect(list).toHaveBeenCalledWith("proj-1");
  });

  it("does not fetch without a project", () => {
    const { result } = renderHook(() => useRepoNames(null), {
      wrapper: makeWrapper({ withAuth: false }),
    });
    expect(result.current).toEqual({});
    expect(list).not.toHaveBeenCalled();
  });
});

describe("useRepoNamesForProjects (#363)", () => {
  it("merges every listed project's connectors into one map", async () => {
    list.mockImplementation(async (projectId: string) =>
      projectId === "p1"
        ? [{ id: "c1", repoName: "metis", label: "x" }]
        : [{ id: "c2", repoName: "wms", label: "y" }],
    );
    const { result } = renderHook(() => useRepoNamesForProjects(["p1", "p2"]), {
      wrapper: makeWrapper({ withAuth: false }),
    });
    await waitFor(() => expect(result.current).toEqual({ c1: "metis", c2: "wms" }));
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("fetches nothing for no projects", () => {
    const { result } = renderHook(() => useRepoNamesForProjects([]), {
      wrapper: makeWrapper({ withAuth: false }),
    });
    expect(result.current).toEqual({});
    expect(list).not.toHaveBeenCalled();
  });
});
