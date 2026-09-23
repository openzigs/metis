/**
 * #61 — the project-scoped Impact Analysis page lists this project's own runs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import type { ImpactAnalysisSummary } from "@metis/shared";
import { makeWrapper } from "../test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1/impact",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from "@/lib/api-client";
import ImpactPage from "@/app/(authed)/projects/[id]/impact/page";

const fetchMock = vi.mocked(apiFetch);

const row = (id: string, projectIds: string[]): ImpactAnalysisSummary => ({
  id,
  status: "completed",
  documentId: null,
  summary: null,
  projectCount: projectIds.length,
  projectIds,
  totalImpactedSymbols: 4,
  startedAt: "2026-09-22T10:00:00.000Z",
  completedAt: "2026-09-22T10:05:00.000Z",
  rerunOfId: null,
});

beforeEach(() => vi.clearAllMocks());

describe("project Impact Analysis page (#61)", () => {
  it("asks the server for this project's runs and lists them", async () => {
    fetchMock.mockResolvedValue([row("ia-mine", ["p1", "p2"])]);
    render(<ImpactPage />, { wrapper: makeWrapper({ withAuth: false }) });

    expect(await screen.findByTestId("impact-list-link-ia-mine")).toHaveAttribute(
      "href",
      "/impact-analyses/ia-mine",
    );
    expect(fetchMock).toHaveBeenCalledWith("/impact-analyses", { params: { projectId: "p1" } });
  });

  it("never lists a run that does not include this project", async () => {
    fetchMock.mockResolvedValue([row("ia-mine", ["p1"]), row("ia-other", ["p2"])]);
    render(<ImpactPage />, { wrapper: makeWrapper({ withAuth: false }) });

    await screen.findByTestId("impact-list-link-ia-mine");
    expect(screen.queryByTestId("impact-list-row-ia-other")).not.toBeInTheDocument();
  });

  it("says so when no run includes this project", async () => {
    fetchMock.mockResolvedValue([]);
    render(<ImpactPage />, { wrapper: makeWrapper({ withAuth: false }) });
    expect(await screen.findByTestId("impact-list-empty")).toHaveTextContent(/this project/i);
  });

  it("reports a failed load", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    render(<ImpactPage />, { wrapper: makeWrapper({ withAuth: false }) });
    await waitFor(() => expect(screen.getByTestId("impact-list-error")).toBeInTheDocument());
  });
});
