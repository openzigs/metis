import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SharedTableImpact } from "@metis/shared";
import { SharedTableImpactSection } from "@/components/impact/shared-table-impact-section";

const shared: SharedTableImpact[] = [
  { tableName: "account", projectIds: ["reporting", "storefront"] },
];

describe("SharedTableImpactSection — #956 run-level rollup", () => {
  it("renders nothing when no table is shared (single-project unchanged)", () => {
    const { container } = render(<SharedTableImpactSection sharedTableImpacts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("flags shared tables with the impacted project names", () => {
    render(
      <SharedTableImpactSection
        sharedTableImpacts={shared}
        projectName={(id) => (id === "reporting" ? "Reporting" : "Storefront")}
      />,
    );
    expect(screen.getByTestId("shared-table-impact-count")).toHaveTextContent("1 shared table");
    const row = screen.getByTestId("shared-table-impact-row");
    expect(row).toHaveAttribute("data-table-name", "account");
    expect(row).toHaveTextContent("Reporting");
    expect(row).toHaveTextContent("Storefront");
  });

  it("falls back to project ids when no name resolver is given", () => {
    render(<SharedTableImpactSection sharedTableImpacts={shared} />);
    expect(screen.getByTestId("shared-table-impact-row")).toHaveTextContent(
      "reporting, storefront",
    );
  });
});
