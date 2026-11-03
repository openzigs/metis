/**
 * Issue #1615 — a multi-project impact run lists the projects it checked and
 * found nothing in, and the ones it did not check, with the reason (#1609).
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ImpactProjectOutcome } from "@metis/shared";
import {
  ImpactProjectOutcomesGroup,
  impactOutcomeLabel,
  noProjectChecked,
  quietProjectIds,
} from "./project-outcomes-group";

const names: Record<string, string> = { "p-a": "Alpha", "p-b": "Beta", "p-c": "Gamma" };
const projectName = (id: string) => names[id] ?? id;

const outcome = (
  projectId: string,
  o: ImpactProjectOutcome["outcome"],
  reason: ImpactProjectOutcome["reason"] = null,
): ImpactProjectOutcome => ({ projectId, outcome: o, reason });

describe("impactOutcomeLabel", () => {
  it("says what happened for each outcome and reason", () => {
    expect(impactOutcomeLabel(outcome("x", "checked-none-affected"))).toBe(
      "Checked: nothing affected",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", "restricted"))).toBe(
      "Not checked: no access",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", "deleted"))).toBe(
      "Not checked: project deleted",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", "no-index"))).toBe(
      "Not checked: no code index",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", "timeout"))).toBe(
      "Not checked: timed out",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", "budget"))).toBe(
      "Not checked: cost limit reached",
    );
    expect(impactOutcomeLabel(outcome("x", "not-checked", null))).toBe("Not checked");
    expect(impactOutcomeLabel(outcome("x", "error"))).toBe("Error: the check failed");
  });
});

describe("quietProjectIds", () => {
  it("collects every project whose outcome is not affected", () => {
    const ids = quietProjectIds([
      outcome("p-a", "affected"),
      outcome("p-b", "checked-none-affected"),
      outcome("p-c", "not-checked", "restricted"),
    ]);
    expect([...ids].sort()).toEqual(["p-b", "p-c"]);
  });

  it("is empty for a run recorded before outcomes existed", () => {
    expect(quietProjectIds(undefined).size).toBe(0);
  });
});

describe("noProjectChecked (#1636)", () => {
  it("is true only when outcomes were recorded and none was searched", () => {
    expect(
      noProjectChecked([outcome("p-a", "not-checked", "no-index"), outcome("p-b", "error")]),
    ).toBe(true);
    expect(
      noProjectChecked([
        outcome("p-a", "not-checked", "no-index"),
        outcome("p-b", "checked-none-affected"),
      ]),
    ).toBe(false);
    expect(noProjectChecked([outcome("p-a", "affected")])).toBe(false);
    // A run from before outcomes were recorded says nothing either way.
    expect(noProjectChecked([])).toBe(false);
    expect(noProjectChecked(undefined)).toBe(false);
  });
});

describe("ImpactProjectOutcomesGroup", () => {
  it("#1636 opens on first render when asked", () => {
    render(
      <ImpactProjectOutcomesGroup
        outcomes={[outcome("p-c", "not-checked", "no-index")]}
        projectName={projectName}
        defaultOpen
      />,
    );
    expect(screen.getByTestId("impact-project-outcomes")).toHaveAttribute("open");
  });

  it("lists zero-hit and unchecked projects in one collapsed group, without the affected ones", () => {
    render(
      <ImpactProjectOutcomesGroup
        outcomes={[
          outcome("p-a", "affected"),
          outcome("p-b", "checked-none-affected"),
          outcome("p-c", "not-checked", "no-index"),
        ]}
        projectName={projectName}
      />,
    );
    const group = screen.getByTestId("impact-project-outcomes");
    expect(group.tagName).toBe("DETAILS");
    expect(group).not.toHaveAttribute("open");
    const rows = within(group).getAllByTestId("impact-project-outcome");
    expect(rows.map((r) => r.textContent)).toEqual([
      "Beta — Checked: nothing affected",
      "Gamma — Not checked: no code index",
    ]);
    expect(group).not.toHaveTextContent("Alpha");
    expect(within(group).getByText(/2 projects/)).toBeInTheDocument();
  });

  it("renders a restricted project with no name and no id", () => {
    render(
      <ImpactProjectOutcomesGroup
        outcomes={[outcome("p-secret", "not-checked", "restricted")]}
        projectName={() => "Secret Project"}
      />,
    );
    const row = screen.getByTestId("impact-project-outcome");
    // #1636 — the reader can open every project of a run they can see, so the
    // label names whose access failed: the run's starter's.
    expect(row).toHaveTextContent(
      "A project the run's starter could not access — Not checked: no access",
    );
    expect(row).not.toHaveTextContent("you cannot");
    expect(row).not.toHaveTextContent("Secret Project");
    expect(screen.getByTestId("impact-project-outcomes").outerHTML).not.toContain("p-secret");
  });

  it("renders nothing when every project was affected, or no outcomes were recorded", () => {
    const { container } = render(
      <ImpactProjectOutcomesGroup
        outcomes={[outcome("p-a", "affected")]}
        projectName={projectName}
      />,
    );
    expect(container).toBeEmptyDOMElement();
    const { container: none } = render(
      <ImpactProjectOutcomesGroup outcomes={[]} projectName={projectName} />,
    );
    expect(none).toBeEmptyDOMElement();
  });
});
