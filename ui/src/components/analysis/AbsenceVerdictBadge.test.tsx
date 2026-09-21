/**
 * Epic #1107 (#1111 / A3) — the absence verdict on screen.
 *
 * The acceptance criterion this file exists for: **an `unexamined` verdict is
 * visibly distinct from `supported`.** Distinct test id, distinct label,
 * distinct hue, distinct copy — asserted four ways, because the whole cost of
 * #773 was that these two produced identical output.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  summarizeSupportPanels,
  type AbsenceClaimVerdict,
  type FindingAbsenceCheck,
  type FindingSupportPanel,
} from "@metis/shared";
import {
  ABSENCE_VERDICT_CLASSES,
  AbsenceVerdictBadge,
  RequirementConfidenceNote,
  SupportPanelDetails,
} from "./SupportPanelBadge";

const CITE = "src/api/scim.ts:41";

const absence = (over: Partial<FindingAbsenceCheck> = {}): FindingAbsenceCheck => ({
  verdict: "supported",
  citation: CITE,
  reasoning: "the router enumerates every route and none provisions users",
  downgradedFrom: null,
  noSignalReason: null,
  ...over,
});

function panel(check?: FindingAbsenceCheck): FindingSupportPanel {
  return {
    confidence: "medium",
    votes: [
      {
        lens: "support",
        judgement: "supported",
        discardReason: null,
        citation: CITE,
        reasoning: "the excerpt states it",
        counted: true,
      },
    ],
    countedVotes: 1,
    supportedVotes: 1,
    unsupportedVotes: 0,
    uncertainVotes: 0,
    noSignalVotes: 0,
    uncitedVotes: 0,
    usage: { promptTokens: 900, completionTokens: 100, llmCalls: 4 },
    ...(check ? { absenceCheck: check } : {}),
  };
}

describe("AbsenceVerdictBadge (#1111)", () => {
  it("renders nothing for a finding that made no absence claim", () => {
    const { container } = render(<AbsenceVerdictBadge panel={panel()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when no panel ran at all", () => {
    const { container } = render(<AbsenceVerdictBadge panel={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("gives each verdict its own test id and data attribute", () => {
    for (const verdict of ["supported", "contradicted", "unexamined"] as AbsenceClaimVerdict[]) {
      const { unmount } = render(<AbsenceVerdictBadge panel={panel(absence({ verdict }))} />);
      const badge = screen.getByTestId(`absence-verdict-${verdict}`);
      expect(badge).toHaveAttribute("data-absence-verdict", verdict);
      unmount();
    }
  });

  it("renders `unexamined` VISIBLY DIFFERENTLY from `supported`", () => {
    // The acceptance criterion, asserted on the DOM: different label, different
    // hue, different accessible description.
    const { unmount } = render(
      <AbsenceVerdictBadge panel={panel(absence({ verdict: "supported" }))} />,
    );
    const supported = screen.getByTestId("absence-verdict-supported");
    const supportedText = supported.textContent;
    const supportedClass = supported.className;
    const supportedLabel = supported.getAttribute("aria-label");
    unmount();

    render(<AbsenceVerdictBadge panel={panel(absence({ verdict: "unexamined" }))} />);
    const unexamined = screen.getByTestId("absence-verdict-unexamined");
    expect(unexamined.textContent).not.toBe(supportedText);
    expect(unexamined.className).not.toBe(supportedClass);
    expect(unexamined.getAttribute("aria-label")).not.toBe(supportedLabel);
    expect(screen.queryByTestId("absence-verdict-supported")).toBeNull();
  });

  it("labels the verifier's own failure as a fourth state, not as `unexamined`", () => {
    render(
      <AbsenceVerdictBadge
        panel={panel(
          absence({ verdict: null, citation: null, noSignalReason: "provider-error: 503" }),
        )}
      />,
    );
    expect(screen.getByTestId("absence-verdict-no-signal")).toHaveTextContent(
      "Absence not checked",
    );
    expect(screen.queryByTestId("absence-verdict-unexamined")).toBeNull();
  });

  it("puts the contradicting file:line in the tooltip a reader can act on", () => {
    render(<AbsenceVerdictBadge panel={panel(absence({ verdict: "contradicted" }))} />);
    expect(screen.getByTestId("absence-verdict-contradicted")).toHaveAttribute(
      "title",
      expect.stringContaining(CITE),
    );
  });

  it("gives all four states distinct hues", () => {
    const classes = Object.values(ABSENCE_VERDICT_CLASSES);
    expect(new Set(classes).size).toBe(classes.length);
  });

  it("is announced to assistive tech as a status, not silently styled", () => {
    render(<AbsenceVerdictBadge panel={panel(absence({ verdict: "unexamined" }))} />);
    const badge = screen.getByTestId("absence-verdict-unexamined");
    expect(badge).toHaveAttribute("role", "status");
    expect(badge.getAttribute("aria-label")).toContain("nobody looked");
  });
});

describe("SupportPanelDetails + absence (#1111)", () => {
  it("leads the disclosure with the absence verdict, above the lens votes", () => {
    render(<SupportPanelDetails panel={panel(absence({ verdict: "contradicted" }))} />);
    const detail = screen.getByTestId("absence-verdict-detail-contradicted");
    expect(detail).toHaveTextContent("Absence contradicted");
    expect(detail).toHaveTextContent(CITE);
  });

  it("shows nothing extra when the finding made no absence claim", () => {
    render(<SupportPanelDetails panel={panel()} />);
    expect(screen.queryByTestId("absence-verdict-detail-supported")).toBeNull();
    expect(screen.getByTestId("support-panel-details")).toBeInTheDocument();
  });

  it("uses the headline to say 'nobody looked' for an unexamined claim", () => {
    render(
      <SupportPanelDetails panel={panel(absence({ verdict: "unexamined", citation: null }))} />,
    );
    expect(screen.getByTestId("support-panel-details")).toHaveTextContent("nobody looked");
  });
});

describe("RequirementConfidenceNote + absence cautions (#1111)", () => {
  const rollup = (check: FindingAbsenceCheck) =>
    summarizeSupportPanels([{ title: "No SCIM endpoint", supportPanel: panel(check) }]);

  it("warns that a contradicted requirement may already exist", () => {
    render(<RequirementConfidenceNote confidence={rollup(absence({ verdict: "contradicted" }))} />);
    const list = screen.getByTestId("requirement-absence-cautions");
    expect(list).toHaveTextContent("may already exist");
    expect(list).toHaveTextContent(CITE);
  });

  it("warns that an unexamined requirement was never confirmed missing", () => {
    render(
      <RequirementConfidenceNote
        confidence={rollup(absence({ verdict: "unexamined", citation: null }))}
      />,
    );
    const list = screen.getByTestId("requirement-absence-cautions");
    expect(list).toHaveTextContent("Not confirmed missing");
    expect(list).not.toHaveTextContent("may already exist");
  });

  it("renders no caution list when every absence claim checked out", () => {
    render(<RequirementConfidenceNote confidence={rollup(absence())} />);
    expect(screen.queryByTestId("requirement-absence-cautions")).toBeNull();
  });

  it("renders no caution list for a pre-#1111 rollup with no cautions field", () => {
    const legacy = summarizeSupportPanels([{ title: "F", supportPanel: panel() }]);
    render(<RequirementConfidenceNote confidence={legacy} />);
    expect(screen.queryByTestId("requirement-absence-cautions")).toBeNull();
  });
});
