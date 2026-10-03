/**
 * Issue #769 — when a re-synthesis (e.g. after Regenerate) was refused
 * permission to replace a reviewed or healthy requirement set, the user is told
 * the set was kept and why, instead of the Regenerate appearing to do nothing.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RequirementReplacementWithheldNotice } from "@/components/analysis/RequirementReplacementWithheldNotice";

const withheld = {
  reason: "reviewed-work" as const,
  existingCount: 25,
  reviewedCount: 4,
  proposedCount: 30,
  at: "2026-10-02T00:37:14.000Z",
};

describe("RequirementReplacementWithheldNotice", () => {
  it("renders nothing when no replacement was withheld", () => {
    for (const metadata of [{}, null, undefined, { requirementReplacementWithheld: "x" }]) {
      expect(
        render(<RequirementReplacementWithheldNotice metadata={metadata} />).container,
      ).toBeEmptyDOMElement();
    }
  });

  it("says the reviewed set was kept and the new synthesis not applied", () => {
    render(
      <RequirementReplacementWithheldNotice
        metadata={{ requirementReplacementWithheld: withheld }}
      />,
    );
    const notice = screen.getByTestId("requirement-replacement-withheld");
    expect(notice).toHaveTextContent(/kept the existing 25 requirements/);
    expect(notice).toHaveTextContent(/4 of them carry review work/);
    expect(notice).toHaveTextContent(/30 newly synthesized requirements were not applied/);
  });

  it("explains a refused degraded synthesis", () => {
    render(
      <RequirementReplacementWithheldNotice
        metadata={{
          requirementReplacementWithheld: {
            ...withheld,
            reason: "degraded-synthesis",
            reviewedCount: 0,
          },
        }}
      />,
    );
    expect(screen.getByTestId("requirement-replacement-withheld")).toHaveTextContent(
      /degraded result never overwrites a successful one/,
    );
  });
});
