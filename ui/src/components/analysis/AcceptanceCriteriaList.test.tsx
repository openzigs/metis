/**
 * Issue #1096 — the requirement's acceptance criteria in the analysis results UI.
 *
 * Asserting "a criteria section renders" passes against the placeholder bug, so
 * these assert substance: the rendered list carries terms from the requirement's
 * own criteria, an empty set renders a visible "none derived" note, and the old
 * Given/When/Then boilerplate never appears.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AcceptanceCriteriaList } from "./AcceptanceCriteriaList";

const CRITERIA = [
  "INVENTORY.QTY can never go below zero, enforced by a database CHECK constraint.",
  "Two concurrent orders for the last remaining unit yield exactly one success and one rejection.",
];

describe("AcceptanceCriteriaList (#1096)", () => {
  it("renders the requirement's own criteria, one per item", () => {
    render(<AcceptanceCriteriaList criteria={CRITERIA} />);

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("INVENTORY.QTY");
    expect(items[1]).toHaveTextContent("exactly one success and one rejection");
    expect(screen.queryByTestId("no-acceptance-criteria")).not.toBeInTheDocument();
  });

  it("states plainly that none were derived instead of showing filler", () => {
    render(<AcceptanceCriteriaList criteria={[]} />);

    expect(screen.getByTestId("no-acceptance-criteria")).toHaveTextContent(
      /No acceptance criteria were derived/,
    );
    expect(screen.queryAllByRole("listitem")).toHaveLength(0);
    expect(screen.queryByText(/the change ships/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Given.*the system is configured/i)).not.toBeInTheDocument();
  });
});
