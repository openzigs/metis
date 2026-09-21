/**
 * Issue #739 (Epic #727) — AnalysisDepthPanel component tests.
 *
 * Locks the per-requirement depth indicator: escalated requirements get a "deep
 * analysis" badge, the rest a "standard" badge, each carries a score tooltip, and
 * a summary line counts deep vs standard. A null / empty escalation renders
 * nothing (policy-off / pre-#739 runs degrade gracefully).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AnalysisDepthPanel } from "./analysis-depth-panel";
import type { AnalysisEscalation } from "@/lib/analysis-api";

const escalation: AnalysisEscalation = {
  enabled: true,
  threshold: 0.5,
  maxEscalations: 3,
  requirements: [
    {
      requirementId: "REQ-VAGUE",
      text: "Handle everything appropriately",
      ambiguityScore: 1,
      impactScore: 0.125,
      score: 0.5625,
      blastRadiusSize: 1,
      depth: "deep",
    },
    {
      requirementId: "REQ-CRISP",
      text: "The footer renders the build version",
      ambiguityScore: 0,
      impactScore: 0.125,
      score: 0.0625,
      blastRadiusSize: 1,
      depth: "standard",
    },
  ],
};

describe("AnalysisDepthPanel (#739)", () => {
  it("renders nothing when escalation is null", () => {
    const { container } = render(<AnalysisDepthPanel escalation={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when there are no scored requirements", () => {
    const { container } = render(
      <AnalysisDepthPanel escalation={{ ...escalation, requirements: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("marks the escalated requirement deep and the other standard", () => {
    render(<AnalysisDepthPanel escalation={escalation} />);
    expect(screen.getByTestId("analysis-depth-badge-REQ-VAGUE")).toHaveTextContent("deep analysis");
    expect(screen.getByTestId("analysis-depth-badge-REQ-CRISP")).toHaveTextContent("standard");
  });

  it("summarizes the deep vs standard counts", () => {
    render(<AnalysisDepthPanel escalation={escalation} />);
    expect(screen.getByTestId("analysis-depth-summary")).toHaveTextContent("1 deep · 1 standard");
  });

  it("exposes the score breakdown as a tooltip on the deep badge", () => {
    render(<AnalysisDepthPanel escalation={escalation} />);
    const badge = screen.getByTestId("analysis-depth-badge-REQ-VAGUE");
    expect(badge.getAttribute("title")).toContain("score 0.56");
    expect(badge.getAttribute("title")).toContain("ambiguity 1.00");
    expect(badge.getAttribute("title")).toContain("impact 0.13");
  });
});
