/**
 * Issue #2345 — impact analysis and the portfolio check on the change request:
 * started from its card with its requirements pre-filled (the server reads
 * them), results listed newest first with a pre-approval label, the full forms
 * pre-filled from it, and every result page linking back to it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  createImpactAnalysisSchema,
  createPortfolioAssessmentSchema,
  PORTFOLIO_PRE_APPROVAL_LABEL,
} from "@metis/shared";
import { makeWrapper } from "../test-utils";

const listForChangeRequest = vi.hoisted(() => vi.fn());
const createImpact = vi.hoisted(() => vi.fn());
vi.mock("@/lib/impact-analysis-api", () => ({
  impactAnalysisApi: { listForChangeRequest, create: createImpact },
}));
const listForRun = vi.hoisted(() => vi.fn());
const createPortfolio = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portfolio-api", () => ({
  portfolioApi: { listForRun, create: createPortfolio },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { AnalysisSnapshot } from "@/lib/analysis-api";
import {
  ChangeRequestChecks,
  changeRequestFormHrefs,
  checkedRequirements,
  impactCheckedCopy,
} from "@/components/analysis/change-request-checks";
import { PortfolioAssessmentForm } from "@/components/portfolio/portfolio-assessment-form";
import { portfolioCheckHref } from "@/components/portfolio/portfolio-check-link";
import {
  ChangeRequestBackLink,
  changeRequestHref,
} from "@/components/analysis/change-request-back-link";

type Req = AnalysisSnapshot["requirements"][number];
const req = (id: string, reviewStatus: string) => ({ id, reviewStatus }) as unknown as Req;

function snapshot(requirements: Req[]): AnalysisSnapshot {
  return { id: "an-1", projectId: "p1", requirements } as unknown as AnalysisSnapshot;
}

function renderCard(requirements: Req[], canRun = true) {
  return render(
    <ChangeRequestChecks
      projectId="p1"
      snapshot={snapshot(requirements)}
      title="Password reset"
      canRun={canRun}
    />,
    { wrapper: makeWrapper() },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listForChangeRequest.mockResolvedValue([]);
  listForRun.mockResolvedValue([]);
  createImpact.mockResolvedValue({ id: "ia-1", status: "pending", projectIds: ["p1"] });
  createPortfolio.mockResolvedValue({ id: "pa-1" });
});

describe("#2345 — the pre-fill", () => {
  it("counts the draft and approved requirements a check reads, and those not approved", () => {
    expect(
      checkedRequirements(
        snapshot([
          req("a", "draft"),
          req("b", "approved"),
          req("c", "rejected"),
          req("d", "deferred"),
        ]),
      ),
    ).toEqual({ count: 2, unapproved: 1 });
    expect(checkedRequirements(snapshot([]))).toEqual({ count: 0, unapproved: 0 });
  });

  it("pre-fills both full forms from the change request", () => {
    const hrefs = changeRequestFormHrefs("p 1", "an-1", "Reset & more");
    expect(hrefs.impact).toBe("/impact-analyses/new?projectId=p+1&analysisId=an-1");
    expect(hrefs.portfolio).toBe("/portfolio?analysisId=an-1&title=Reset+%26+more&projectId=p+1");
    expect(portfolioCheckHref({ analysisId: "an-1", title: "x".repeat(300) })).toBe(
      `/portfolio?analysisId=an-1&title=${"x".repeat(200)}`,
    );
  });
});

describe("#2345 — the change request's Impact and portfolio card", () => {
  it("starts an impact analysis over the change request and its project, typing nothing", async () => {
    const user = userEvent.setup();
    renderCard([req("a", "approved")]);
    await user.click(screen.getByTestId("change-request-run-impact"));
    await waitFor(() => expect(createImpact).toHaveBeenCalled());
    const sent = createImpact.mock.calls[0][0];
    expect(sent).toEqual({ analysisId: "an-1", projectIds: ["p1"] });
    // The contract accepts that shape (with ids of a real length; these are short).
    expect(
      createImpactAnalysisSchema.safeParse({
        ...sent,
        analysisId: "an-0000000001",
        projectIds: ["project-0001"],
      }).success,
    ).toBe(true);
  });

  it("starts a portfolio check before approval, over the products the analyst can read, and says it will be labelled", async () => {
    const user = userEvent.setup();
    renderCard([req("a", "draft"), req("b", "approved")]);
    expect(screen.getByTestId("change-request-checks-source")).toHaveTextContent(
      "Checks this change request's 2 requirements",
    );
    expect(screen.getByTestId("change-request-checks-source")).toHaveTextContent(
      "1 is not approved yet: a portfolio check now is labelled as run on unapproved requirements.",
    );
    const run = screen.getByTestId("change-request-run-portfolio");
    expect(run).toBeEnabled();
    await user.click(run);
    await waitFor(() => expect(createPortfolio).toHaveBeenCalled());
    const sent = createPortfolio.mock.calls[0][0];
    expect(sent).toEqual({ analysisId: "an-1", scope: "all-accessible" });
    expect(createPortfolioAssessmentSchema.safeParse(sent).success).toBe(true);
  });

  it("says an impact analysis checks the first 50 of a larger change request's requirements", () => {
    renderCard(Array.from({ length: 51 }, (_, i) => req(`r${i}`, "approved")));
    const source = screen.getByTestId("change-request-checks-source");
    expect(source).toHaveTextContent("Checks this change request's 51 requirements");
    expect(source).toHaveTextContent("An impact analysis checks the first 50 of the 51.");
    expect(impactCheckedCopy(50)).toBeNull();
    expect(impactCheckedCopy(51)).toBe("An impact analysis checks the first 50 of the 51.");
  });

  it("offers nothing to run while the change request has no requirement to check", () => {
    renderCard([req("c", "rejected")]);
    expect(screen.getByTestId("change-request-run-impact")).toBeDisabled();
    expect(screen.getByTestId("change-request-run-portfolio")).toBeDisabled();
    expect(screen.queryByTestId("change-request-impact-options")).toBeNull();
    expect(screen.getByTestId("change-request-checks-source")).toHaveTextContent(
      "No draft or approved requirements to check yet.",
    );
  });

  it("shows a reader without analysis.run the results, and no way to start one", async () => {
    renderCard([req("a", "approved")], false);
    expect(screen.queryByTestId("change-request-run-impact")).toBeNull();
    expect(screen.queryByTestId("change-request-run-portfolio")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("change-request-impact-empty")).toBeVisible());
  });

  it("lists the results newest first, the older ones still reachable, and labels a pre-approval check", async () => {
    listForChangeRequest.mockResolvedValue([
      {
        id: "ia-new",
        status: "completed",
        totalImpactedSymbols: 3,
        startedAt: "2026-11-12T10:00:00Z",
      },
      {
        id: "ia-old",
        status: "failed",
        totalImpactedSymbols: 0,
        startedAt: "2026-11-11T10:00:00Z",
      },
    ]);
    listForRun.mockResolvedValue([
      {
        id: "pa-new",
        status: "completed",
        verdict: "partial",
        preApproval: true,
        createdAt: "2026-11-12T10:00:00Z",
      },
      {
        id: "pa-old",
        status: "completed",
        verdict: "implemented",
        preApproval: false,
        createdAt: "2026-11-10T10:00:00Z",
      },
    ]);
    renderCard([req("a", "approved")]);
    const impact = await screen.findAllByTestId("change-request-impact-result");
    expect(impact.map((li) => within(li).getByRole("link").getAttribute("href"))).toEqual([
      "/impact-analyses/ia-new",
      "/impact-analyses/ia-old",
    ]);
    expect(impact[0]).toHaveTextContent("Completed · 3 affected symbols");
    expect(impact[0]).toHaveTextContent("Latest");
    expect(impact[1]).not.toHaveTextContent("Latest");
    expect(impact[1]).toHaveTextContent("Failed");

    const checks = await screen.findAllByTestId("change-request-portfolio-result");
    expect(checks.map((li) => within(li).getByRole("link").getAttribute("href"))).toEqual([
      "/portfolio/pa-new",
      "/portfolio/pa-old",
    ]);
    expect(checks[0]).toHaveTextContent("Partly covered");
    expect(checks[0]).toHaveTextContent(PORTFOLIO_PRE_APPROVAL_LABEL);
    expect(checks[1]).not.toHaveTextContent(PORTFOLIO_PRE_APPROVAL_LABEL);
    expect(listForChangeRequest).toHaveBeenCalledWith("an-1");
    expect(listForRun).toHaveBeenCalledWith("an-1");
  });

  it("says when the results could not be read", async () => {
    listForChangeRequest.mockRejectedValue(new Error("boom"));
    listForRun.mockRejectedValue(new Error("boom"));
    renderCard([req("a", "approved")]);
    expect(await screen.findByText("Could not load the impact analyses.")).toBeVisible();
    expect(await screen.findByText("Could not load the portfolio checks.")).toBeVisible();
  });
});

describe("#2345 — the portfolio form from a change request", () => {
  it("sends the change request, not a statement, and can drop it to type one", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClear = vi.fn();
    render(
      <PortfolioAssessmentForm
        products={[{ id: "p-1", name: "Billing" }]}
        pending={false}
        onSubmit={onSubmit}
        changeRequest={{ id: "an-1", title: "Password reset" }}
        onClearChangeRequest={onClear}
      />,
    );
    const block = screen.getByTestId("portfolio-form-change-request");
    expect(block).toHaveTextContent("Password reset");
    expect(block).toHaveTextContent("labelled as run on unapproved requirements");
    expect(screen.queryByLabelText("Requirement statement")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Check coverage" }));
    expect(onSubmit).toHaveBeenCalledWith({ analysisId: "an-1", scope: "all-accessible" });
    await user.click(screen.getByRole("button", { name: "Type a statement instead" }));
    expect(onClear).toHaveBeenCalled();
  });
});

describe("#2345 — the link back to the change request", () => {
  it("returns to the change request's page in one click, its title as text", () => {
    expect(changeRequestHref({ id: "an 1", projectId: "p/1" })).toBe(
      "/projects/p%2F1/analysis?analysisId=an+1",
    );
    render(
      <ChangeRequestBackLink
        changeRequest={{ id: "an-1", projectId: "p1", title: "<b>Reset</b>" }}
        testId="back"
      />,
    );
    const link = screen.getByTestId("back");
    expect(link).toHaveAttribute("href", "/projects/p1/analysis?analysisId=an-1");
    expect(link).toHaveTextContent("← Back to the change request: <b>Reset</b>");
  });
});
