/**
 * Issue #2448 — the run's restricted-files line: what a shared-audience run
 * left out (#2437), or how many restricted files a run read with the access of
 * the person who ran it, so a reader knows why a row may show as restricted.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import type { AnalysisCapability } from "@metis/shared";
import { RestrictedLeftOutNotice } from "./restricted-left-out-notice";

const cap = (over: Record<string, unknown>) => over as unknown as AnalysisCapability;

describe("RestrictedLeftOutNotice (#2448)", () => {
  it("says how many restricted files the run read with its runner's access", () => {
    render(<RestrictedLeftOutNotice capability={cap({ restrictedRead: 2 })} />);
    expect(screen.getByRole("note")).toHaveTextContent(
      "This analysis read 2 restricted files with the access of the person who ran it. Anyone who can't see one of them sees what drew on it as restricted.",
    );
  });

  it("keeps the left-out line for a run that read as the shared audience, and shows both when both apply", () => {
    render(
      <RestrictedLeftOutNotice
        capability={cap({
          restrictedLeftOut: { reason: "shared-audience", files: 0, symbols: 0, documentChunks: 1 },
          restrictedRead: 1,
        })}
      />,
    );
    const note = screen.getByTestId("restricted-left-out");
    expect(note).toHaveTextContent(
      "1 matching passage from a restricted document was left out: results are shared with the whole project",
    );
    expect(note).toHaveTextContent("This analysis read 1 restricted file");
  });

  it("renders nothing when the run neither left out nor read a restricted file", () => {
    const { container } = render(
      <RestrictedLeftOutNotice capability={cap({ restrictedRead: 0 })} />,
    );
    expect(container).toBeEmptyDOMElement();
    render(<RestrictedLeftOutNotice capability={null} />);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
