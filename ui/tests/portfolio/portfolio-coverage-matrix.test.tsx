/**
 * #1626 — the coverage matrix and headline: five products in five states
 * render five rows; a covering or partial row expands, by keyboard, to its
 * repo-stamped citations; states carry words, not colour alone; axe passes.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { coverageHeadline, coverageRows } from "@/lib/portfolio-coverage";
import { PortfolioCoverageMatrix } from "@/components/portfolio/portfolio-coverage-matrix";
import { PortfolioCoverageHeadline } from "@/components/portfolio/portfolio-coverage-headline";
import { PortfolioAssessmentProgress } from "@/components/portfolio/portfolio-assessment-progress";
import { fiveStates, view } from "./fixtures";
import { axeViolations } from "./axe";

function renderMatrix() {
  return render(<PortfolioCoverageMatrix rows={coverageRows(fiveStates())} />);
}

describe("PortfolioCoverageMatrix", () => {
  it("renders five rows for five products in five states", () => {
    renderMatrix();
    const rows = screen.getAllByTestId("portfolio-coverage-row");
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.getAttribute("data-coverage"))).toEqual([
      "covers",
      "partial",
      "not-covered",
      "not-checked",
      "restricted",
    ]);
  });

  it("says each state in words, and why a product was not checked", () => {
    renderMatrix();
    const rows = screen.getAllByTestId("portfolio-coverage-row");
    expect(rows.map((r) => within(r).getByTestId("coverage-state").textContent)).toEqual([
      "Covers it",
      "Partly covers it",
      "Does not cover it",
      "Not checkedBecause it has no repositories attached.",
      "Restricted",
    ]);
  });

  it("shows a restricted product without its name", () => {
    renderMatrix();
    const restricted = screen.getAllByTestId("portfolio-coverage-row")[4];
    expect(within(restricted).getByRole("rowheader").textContent).toBe("A product you cannot read");
    expect(within(restricted).queryByRole("button")).toBeNull();
  });

  it("expands a covering row to repo-stamped citations, and collapses it again", async () => {
    const user = userEvent.setup();
    renderMatrix();
    const toggle = screen.getByRole("button", { name: /show 2 citations for billing/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("portfolio-citations")).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const panel = screen.getByTestId("portfolio-citations");
    expect(toggle).toHaveAttribute("aria-controls", panel.id);
    expect(
      within(panel)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["acme/payments · src/transfer.ts:42", "acme/payments · src/iban.ts:7"]);

    await user.click(toggle);
    expect(screen.queryByTestId("portfolio-citations")).toBeNull();
  });

  it("expands a partial row too, and only covering and partial rows expand", () => {
    renderMatrix();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Show 2 citations for Billing",
      "Show 1 citation for Ledger",
    ]);
  });

  it("does not offer to expand a covering row with no citations", () => {
    const v = fiveStates();
    v.repos = [];
    render(<PortfolioCoverageMatrix rows={coverageRows(v)} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("is keyboard operable: Tab reaches each toggle, Enter and Space open it", async () => {
    const user = userEvent.setup();
    renderMatrix();
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Show 2 citations for Billing");
    await user.keyboard("{Enter}");
    expect(screen.getAllByTestId("portfolio-citations")).toHaveLength(1);
    await user.tab();
    expect(document.activeElement).toHaveAccessibleName("Show 1 citation for Ledger");
    await user.keyboard(" ");
    expect(screen.getAllByTestId("portfolio-citations")).toHaveLength(2);
  });

  it("passes axe, collapsed and expanded", async () => {
    const user = userEvent.setup();
    const { container } = renderMatrix();
    expect(await axeViolations(container)).toEqual([]);
    for (const b of screen.getAllByRole("button")) await user.click(b);
    expect(await axeViolations(container)).toEqual([]);
  });
});

describe("PortfolioCoverageHeadline", () => {
  it("renders the answer as a heading with an icon and words", async () => {
    const { container } = render(
      <PortfolioCoverageHeadline headline={coverageHeadline(fiveStates())!} />,
    );
    expect(
      screen.getByRole("heading", { name: "Covered by Billing (acme/payments)" }),
    ).toBeVisible();
    expect(screen.getByTestId("portfolio-coverage-headline")).toHaveAttribute(
      "data-tone",
      "covered",
    );
    expect(await axeViolations(container)).toEqual([]);
  });

  it("says nothing covers it", () => {
    render(
      <PortfolioCoverageHeadline
        headline={coverageHeadline(view({ verdict: "gap-confirmed" }))!}
      />,
    );
    expect(
      screen.getByRole("heading", { name: "Nothing in your portfolio covers this" }),
    ).toBeVisible();
  });
});

describe("PortfolioAssessmentProgress", () => {
  it("shows the job's step and percentage", async () => {
    const { container } = render(
      <PortfolioAssessmentProgress
        status="running"
        job={{
          kind: "portfolio-assessment",
          jobId: "pa-1",
          projectId: null,
          status: "progress",
          progress: 40,
          message: "2 of 5 products checked",
          ts: 1,
        }}
      />,
    );
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("2 of 5 products checked");
    expect(screen.getByRole("progressbar", { name: "40% of products checked" })).toBeVisible();
    expect(await axeViolations(container)).toEqual([]);
  });

  it("reads from the status before any job event arrives", () => {
    const { rerender } = render(<PortfolioAssessmentProgress status="pending" job={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting to start");
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(<PortfolioAssessmentProgress status="running" job={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Checking each product in scope");
  });
});
