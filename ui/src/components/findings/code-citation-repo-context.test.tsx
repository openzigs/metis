import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const list = vi.fn();
vi.mock("@/lib/connectors-api", () => ({ repoConnectorsApi: { list: (id: string) => list(id) } }));

const { useCodeCitationRepo, useCodeCitationRepoContext } =
  await import("./code-citation-repo-context");

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const github = {
  provider: "github",
  ownerOrOrg: "miniflux",
  repoName: "v2",
  defaultBranch: "v2.3.3",
  apiBaseUrl: null,
  lastCommitSha: null,
  deletedAt: null,
};

describe("useCodeCitationRepo (#728)", () => {
  beforeEach(() => list.mockReset());

  it("resolves the project's single GitHub connector", async () => {
    list.mockResolvedValue([github]);
    const { result } = renderHook(() => useCodeCitationRepo("p1"), { wrapper });
    await waitFor(() =>
      expect(result.current).toEqual({
        origin: "https://github.com",
        owner: "miniflux",
        repo: "v2",
        ref: "v2.3.3",
      }),
    );
    expect(list).toHaveBeenCalledWith("p1");
  });

  it("is null with two GitHub connectors, since a citation names neither", async () => {
    list.mockResolvedValue([github, { ...github, repoName: "other" }]);
    const { result } = renderHook(() => useCodeCitationRepo("p1"), { wrapper });
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(result.current).toBeNull();
  });

  it("does not fetch without a project id", () => {
    const { result } = renderHook(() => useCodeCitationRepo(""), { wrapper });
    expect(result.current).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  it("the context defaults to null outside a provider", () => {
    const { result } = renderHook(() => useCodeCitationRepoContext());
    expect(result.current).toBeNull();
  });
});
