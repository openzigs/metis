/**
 * Epic #1107 (#1110 / A2) — the panel's UI treatment.
 *
 * Asserts the three things the issue asks the UI to make true: low-confidence
 * findings are SECOND-CLASS but never hidden or filtered; `no-signal` renders
 * distinctly from `low` in label, hue and card treatment; and the dissenting
 * lens's own reason + `file:line` is in the DOM from the snapshot alone.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { summarizeSupportPanels, type FindingSupportPanel } from "@metis/shared";
import {
  RequirementConfidenceNote,
  SUPPORT_PANEL_COPY,
  SupportPanelBadge,
  SupportPanelDetails,
  findingConfidenceClasses,
  orderFindingsByConfidence,
} from "./SupportPanelBadge";

function panel(confidence: FindingSupportPanel["confidence"]): FindingSupportPanel {
  const judged = confidence !== "no-signal";
  return {
    confidence,
    votes: [
      {
        lens: "support",
        judgement: judged ? "supported" : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/refund.ts:12" : null,
        reasoning: judged ? "the handler exists" : "provider-error: upstream 503",
        counted: judged,
      },
      {
        lens: "scope",
        judgement: judged ? (confidence === "high" ? "supported" : "unsupported") : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/refund.ts:30" : null,
        reasoning: judged
          ? "one handler does not make this system-wide"
          : "provider-error: upstream 503",
        counted: judged,
      },
      {
        lens: "currency",
        judgement: judged ? (confidence === "low" ? "unsupported" : "supported") : null,
        discardReason: judged ? null : "no-signal",
        citation: judged ? "src/api/refund.ts:44" : null,
        reasoning: judged ? "a later excerpt supersedes this" : "provider-error: upstream 503",
        counted: judged,
      },
    ],
    countedVotes: judged ? 3 : 0,
    supportedVotes: confidence === "high" ? 3 : confidence === "low" ? 1 : judged ? 2 : 0,
    unsupportedVotes: confidence === "low" ? 2 : confidence === "medium" ? 1 : 0,
    uncertainVotes: 0,
    noSignalVotes: judged ? 0 : 3,
    uncitedVotes: 0,
    usage: { promptTokens: 900, completionTokens: 100, llmCalls: 3 },
  };
}

describe("SupportPanelBadge (#1110)", () => {
  it("renders nothing when the panel did not run — a flag-off finding is unchanged", () => {
    const { container } = render(<SupportPanelBadge panel={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("labels low confidence as a warning and puts the tally in its accessible name", () => {
    render(<SupportPanelBadge panel={panel("low")} />);
    const badge = screen.getByTestId("support-panel-badge-low");
    expect(badge).toHaveTextContent("Low confidence");
    expect(badge.getAttribute("aria-label")).toContain("1 of 3 lenses supported this claim");
    expect(badge).toHaveAttribute("data-confidence", "low");
  });

  it("labels no-signal as NOT JUDGED — never as doubt", () => {
    render(<SupportPanelBadge panel={panel("no-signal")} />);
    const badge = screen.getByTestId("support-panel-badge-no-signal");
    expect(badge).toHaveTextContent("Not judged");
    expect(badge).not.toHaveTextContent(/confidence/i);
    expect(badge.getAttribute("title")).toMatch(/missing information, not doubt/i);
  });

  it("gives every state its own hue, and keeps low and no-signal at opposite ends", () => {
    const classes = new Set(Object.values(SUPPORT_PANEL_COPY).map((c) => c.className));
    expect(classes.size).toBe(4);
    expect(SUPPORT_PANEL_COPY.low.className).toMatch(/rose/);
    expect(SUPPORT_PANEL_COPY["no-signal"].className).toMatch(/slate/);
    expect(SUPPORT_PANEL_COPY.high.className).toMatch(/emerald/);
  });

  it("never presents a confident label as a truth claim", () => {
    expect(SUPPORT_PANEL_COPY.high.tooltip).toMatch(/not a claim that the finding is true/i);
  });
});

describe("SupportPanelDetails (#1110)", () => {
  it("puts each dissenting lens's own reason and file:line in the DOM, with no extra request", () => {
    render(<SupportPanelDetails panel={panel("low")} />);
    const scope = screen.getByTestId("support-panel-vote-scope");
    expect(scope).toHaveTextContent("scope lens — dissented");
    expect(scope).toHaveTextContent("one handler does not make this system-wide");
    expect(scope).toHaveTextContent("src/api/refund.ts:30");
  });

  it("summarises with the dissent, not a bare percentage", () => {
    render(<SupportPanelDetails panel={panel("low")} />);
    const details = screen.getByTestId("support-panel-details");
    expect(details).toHaveTextContent("1 of 3 lenses supported this claim");
    expect(details).toHaveTextContent("the scope and currency lenses dissented");
    expect(details).not.toHaveTextContent("%");
  });

  it("shows a degraded lens as NOT COUNTED rather than as a vote against", () => {
    render(<SupportPanelDetails panel={panel("no-signal")} />);
    const support = screen.getByTestId("support-panel-vote-support");
    expect(support).toHaveTextContent("no verdict (not counted)");
    expect(support).not.toHaveTextContent("dissented");
    expect(screen.getByTestId("support-panel-details")).toHaveTextContent(/could not judge/i);
  });

  it("always carries the retrieval caveat", () => {
    render(<SupportPanelDetails panel={panel("high")} />);
    expect(screen.getByTestId("support-panel-details")).toHaveTextContent(
      /only the evidence this run retrieved/i,
    );
  });

  it("renders nothing when no panel ran", () => {
    const { container } = render(<SupportPanelDetails panel={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("second-class treatment (#1110)", () => {
  it("dims and marks ONLY the low-confidence card", () => {
    expect(findingConfidenceClasses(panel("low"))).toMatch(/opacity-75/);
    expect(findingConfidenceClasses(panel("low"))).toMatch(/rose/);
  });

  it("leaves a no-signal card styled exactly like an unpanelled one", () => {
    expect(findingConfidenceClasses(panel("no-signal"))).toBe("");
    expect(findingConfidenceClasses(null)).toBe("");
  });

  it("leaves high and medium cards untouched", () => {
    expect(findingConfidenceClasses(panel("high"))).toBe("");
    expect(findingConfidenceClasses(panel("medium"))).toBe("");
  });
});

describe("orderFindingsByConfidence (#1110)", () => {
  const f = (id: string, c: FindingSupportPanel["confidence"] | null) => ({
    id,
    supportPanel: c ? panel(c) : null,
  });

  it("ranks low-confidence findings last WITHOUT removing them", () => {
    const out = orderFindingsByConfidence([f("low", "low"), f("high", "high"), f("none", null)]);
    expect(out.map((x) => x.id)).toEqual(["high", "none", "low"]);
    expect(out).toHaveLength(3);
  });

  it("is the identity when no finding carries a panel", () => {
    expect(orderFindingsByConfidence([f("a", null), f("b", null)]).map((x) => x.id)).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("RequirementConfidenceNote (#1110)", () => {
  it("renders nothing when no linked finding carried a panel", () => {
    const { container } = render(<RequirementConfidenceNote confidence={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names the dissenting lens, its reason and the finding it came from", () => {
    const rollup = summarizeSupportPanels([
      { title: "Refunds are blocked", supportPanel: panel("low") },
    ]);
    render(<RequirementConfidenceNote confidence={rollup} />);
    expect(screen.getByTestId("requirement-confidence")).toHaveAttribute("data-confidence", "low");
    const dissent = screen.getByTestId("requirement-confidence-dissent");
    expect(dissent).toHaveTextContent('scope lens on "Refunds are blocked"');
    expect(dissent).toHaveTextContent("one handler does not make this system-wide");
    expect(dissent).toHaveTextContent("src/api/refund.ts:30");
  });

  it("reports unjudged findings as missing information beside a confident rollup", () => {
    const rollup = summarizeSupportPanels([
      { title: "a", supportPanel: panel("high") },
      { title: "b", supportPanel: panel("no-signal") },
    ]);
    render(<RequirementConfidenceNote confidence={rollup} />);
    const note = screen.getByTestId("requirement-confidence");
    expect(note).toHaveAttribute("data-confidence", "high");
    expect(note).toHaveTextContent("1 of its 2 findings could not be judged");
  });

  it("renders no dissent list when every lens agreed", () => {
    const rollup = summarizeSupportPanels([{ title: "a", supportPanel: panel("high") }]);
    render(<RequirementConfidenceNote confidence={rollup} />);
    expect(screen.queryByTestId("requirement-confidence-dissent")).toBeNull();
  });
});
