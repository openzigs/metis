/**
 * Issue #723 — the Analysis page's recovery for a run whose gate is open but
 * which has no requirement rows.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi } = vi.hoisted(() => ({
  analysisApi: { promoteApprovedRequirements: vi.fn() },
}));
vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});

import {
  countApprovedRequirements,
  describePromotionOutcome,
  PromoteApprovedRequirementsButton,
} from "./PromoteApprovedRequirementsButton";
import { ApiError } from "@/lib/api-client";

function renderButton() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PromoteApprovedRequirementsButton projectId="proj_1" analysisId="ana_1" />
    </QueryClientProvider>,
  );
}

describe("countApprovedRequirements", () => {
  it("counts only approved REQUIREMENT approvals", () => {
    expect(
      countApprovedRequirements([
        { type: "requirement", status: "approved" },
        { type: "requirement", status: "rejected" },
        { type: "requirement", status: "pending" },
        { type: "evidence", status: "approved" },
        { type: "clarification", status: "approved" },
        { type: "requirement", status: "approved" },
      ]),
    ).toBe(2);
  });
});

describe("describePromotionOutcome", () => {
  it("is silent on a promotion", () => {
    expect(describePromotionOutcome({ status: "promoted", requirementCount: 3 })).toBeNull();
  });

  it("never claims deleted rows will come back", () => {
    expect(describePromotionOutcome({ status: "already-promoted", requirementCount: 3 })).toContain(
      "any deleted since are not restored",
    );
  });

  it("passes the server's reason through for a blocked or unavailable promotion", () => {
    expect(
      describePromotionOutcome({
        status: "blocked",
        pendingCount: 1,
        rejectedCount: 0,
        awaitingRequirementCount: 2,
        reason: "1 approval pending.",
      }),
    ).toBe("1 approval pending.");
    expect(describePromotionOutcome({ status: "unavailable", reason: "No synthesis." })).toBe(
      "No synthesis.",
    );
  });
});

describe("PromoteApprovedRequirementsButton", () => {
  it("shows the server's error message when the request fails", async () => {
    analysisApi.promoteApprovedRequirements.mockRejectedValueOnce(
      new ApiError(409, "The analysis is still running.", "ANALYSIS_NOT_COMPLETED"),
    );
    renderButton();

    fireEvent.click(screen.getByRole("button", { name: "Promote approved requirements" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The analysis is still running.");
  });

  it("disables itself once the requirements are promoted", async () => {
    analysisApi.promoteApprovedRequirements.mockResolvedValueOnce({
      promotion: { status: "promoted", requirementCount: 2 },
    });
    renderButton();

    const button = screen.getByRole("button", { name: "Promote approved requirements" });
    fireEvent.click(button);

    await vi.waitFor(() => expect(button).toBeDisabled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
