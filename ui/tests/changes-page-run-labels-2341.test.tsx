/**
 * Issue #2341 — the Compare analyses page's base and head pickers name each
 * run by its change request's title, the date after it: never a bare
 * timestamp (with a short id) as the only label.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async (orig) => ({
  ...(await orig<typeof import("next/navigation")>()),
  useParams: () => ({ id: "p1" }),
  usePathname: () => "/projects/p1/changes",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-client")>()),
  apiFetch,
}));
vi.mock("@/lib/change-analysis-api", () => ({
  changeAnalysisApi: { list: vi.fn().mockResolvedValue([]) },
}));

import ChangeAnalysisPage from "@/app/(authed)/projects/[id]/changes/page";
import { formatRunTimestamp } from "@/lib/format-change-run-label";

describe("#2341 — Compare analyses run pickers", () => {
  it("label each completed run by its title, then the sequence and date", async () => {
    const older = "2026-10-01T10:00:00.000Z";
    const newer = "2026-11-01T10:00:00.000Z";
    apiFetch.mockResolvedValue({
      items: [
        {
          id: "an-new",
          status: "completed",
          startedAt: newer,
          completedAt: newer,
          title: "Refunds",
        },
        {
          id: "an-running",
          status: "running",
          startedAt: "2026-11-02T10:00:00.000Z",
          completedAt: null,
          title: "Busy",
        },
        // A payload from an older server, with no title.
        { id: "an-old", status: "completed", startedAt: older, completedAt: older },
      ],
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <ChangeAnalysisPage />
      </Wrapper>,
    );
    for (const testId of ["base-analysis-select", "head-analysis-select"]) {
      await waitFor(() =>
        expect(screen.getByTestId(testId).querySelectorAll("option")).toHaveLength(3),
      );
      const options = Array.from(screen.getByTestId(testId).querySelectorAll("option")).map(
        (o) => o.textContent,
      );
      expect(options).toEqual([
        expect.stringMatching(/^Select /),
        `Refunds · Run #2 — ${formatRunTimestamp(newer)}`,
        `Run #1 — ${formatRunTimestamp(older)}`,
      ]);
    }
  });
});
