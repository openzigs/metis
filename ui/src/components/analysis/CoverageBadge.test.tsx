/**
 * Epic #726 (#736) — CoverageBadge component tests.
 *
 * Locks the three coverage states as visually + semantically distinct: each
 * renders its own label, a distinct colour class, a plain-language tooltip
 * (`title`) and an accessible name, so a non-technical BA can tell them apart.
 * A null/unknown coverage renders nothing (pre-#736 runs degrade gracefully).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { CoverageBadge, COVERAGE_COPY } from "./CoverageBadge";

describe("CoverageBadge (#736)", () => {
  it("renders grounded_in_code with its label + tooltip + testid", () => {
    render(<CoverageBadge coverage="grounded_in_code" />);
    const badge = screen.getByTestId("coverage-badge-grounded_in_code");
    expect(badge).toHaveTextContent(COVERAGE_COPY.grounded_in_code.label);
    expect(badge).toHaveAttribute("title", COVERAGE_COPY.grounded_in_code.tooltip);
    expect(badge).toHaveAttribute("data-coverage", "grounded_in_code");
  });

  it("renders grounded_in_docs_only distinctly", () => {
    render(<CoverageBadge coverage="grounded_in_docs_only" />);
    const badge = screen.getByTestId("coverage-badge-grounded_in_docs_only");
    expect(badge).toHaveTextContent(COVERAGE_COPY.grounded_in_docs_only.label);
    expect(badge).toHaveAttribute("title", COVERAGE_COPY.grounded_in_docs_only.tooltip);
  });

  it("renders no_evidence with actionable tooltip copy", () => {
    render(<CoverageBadge coverage="no_evidence" />);
    const badge = screen.getByTestId("coverage-badge-no_evidence");
    expect(badge).toHaveTextContent(COVERAGE_COPY.no_evidence.label);
    // Issue #773 — the no_evidence tooltip must NOT imply a gap: its real cause is
    // often that retrieval failed. It points the reader at the verdict instead.
    expect(badge.getAttribute("title")).toMatch(/not the same as a confirmed gap/i);
    expect(badge.getAttribute("title")).toMatch(/verdict/i);
  });

  it("gives each state a distinct colour class (visually distinguishable)", () => {
    const classes = new Set(Object.values(COVERAGE_COPY).map((c) => c.className));
    expect(classes.size).toBe(3);
    // Sanity: the three hues are green / amber / red.
    expect(COVERAGE_COPY.grounded_in_code.className).toMatch(/emerald/);
    expect(COVERAGE_COPY.grounded_in_docs_only.className).toMatch(/amber/);
    expect(COVERAGE_COPY.no_evidence.className).toMatch(/red/);
  });

  it("exposes an accessible name that includes the label", () => {
    render(<CoverageBadge coverage="no_evidence" />);
    expect(screen.getByRole("status", { name: /Coverage: No evidence/i })).toBeInTheDocument();
  });

  it("renders nothing for a null coverage (pre-#736 graceful null state)", () => {
    const { container } = render(<CoverageBadge coverage={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an unknown coverage value", () => {
    const { container } = render(<CoverageBadge coverage={"bogus" as unknown as null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
