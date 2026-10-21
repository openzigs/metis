/**
 * Issue #1099 — the requirements view says which values synthesis could not
 * use and left out, so they are checked before publishing.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SynthesisFieldRepairsNotice } from "@/components/analysis/SynthesisFieldRepairsNotice";

const REPAIRS = {
  repairs: [
    {
      field: "storyPoints",
      action: "dropped",
      requirementNumber: 2,
      requirementTitle: "Limit export size",
    },
    { field: "labels", action: "entries-dropped", requirementNumber: 3, requirementTitle: "Audit" },
  ],
  total: 4,
  at: "2026-10-21T00:00:00.000Z",
};

describe("#1099 SynthesisFieldRepairsNotice", () => {
  it("lists each repair by requirement and counts the ones past the cap", () => {
    render(<SynthesisFieldRepairsNotice metadata={{ synthesisFieldRepairs: REPAIRS }} />);
    const notice = screen.getByTestId("synthesis-field-repairs");
    expect(notice.textContent).toContain("The model wrote 4 values METIS could not use");
    expect(notice.textContent).toContain("“Limit export size”: story points left blank");
    expect(notice.textContent).toContain("“Audit”: some labels were left out");
    expect(screen.getByTestId("synthesis-field-repairs-more").textContent).toBe("…and 2 more.");
  });

  it("renders nothing on a run without repairs or with a malformed record", () => {
    const { container } = render(<SynthesisFieldRepairsNotice metadata={{}} />);
    expect(container.firstChild).toBeNull();
    const malformed = render(
      <SynthesisFieldRepairsNotice metadata={{ synthesisFieldRepairs: { repairs: [{}] } }} />,
    );
    expect(malformed.container.firstChild).toBeNull();
  });
});
