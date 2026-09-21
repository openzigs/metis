/**
 * Epic #298 / Issue #312 — DerivationBadge component tests.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DerivationBadge } from "@/components/findings/derivation-badge";

describe("<DerivationBadge />", () => {
  describe("extracted variant", () => {
    it("renders EXTRACTED label with no confidence number", () => {
      render(<DerivationBadge derivation="extracted" confidence={1.0} agentResultId="ar_1" />);
      const badge = screen.getByTestId("derivation-badge-extracted");
      expect(badge).toHaveTextContent("EXTRACTED");
      // No percent number on extracted.
      expect(badge.textContent).not.toMatch(/%/);
      expect(badge.textContent).not.toMatch(/100/);
    });

    it("uses the green Tailwind variant", () => {
      render(<DerivationBadge derivation="extracted" confidence={1.0} agentResultId="ar_1" />);
      const badge = screen.getByTestId("derivation-badge-extracted");
      expect(badge.className).toMatch(/green/);
    });

    it("exposes an aria-label so screen readers identify the variant", () => {
      render(<DerivationBadge derivation="extracted" confidence={1.0} agentResultId="ar_1" />);
      const badge = screen.getByTestId("derivation-badge-extracted");
      expect(badge.getAttribute("aria-label")).toMatch(/extracted/i);
    });
  });

  describe("inferred variant", () => {
    it("renders INFERRED with rounded percentage", () => {
      render(<DerivationBadge derivation="inferred" confidence={0.72} agentResultId="ar_2" />);
      const badge = screen.getByTestId("derivation-badge-inferred");
      expect(badge).toHaveTextContent("INFERRED 72%");
    });

    it("clamps confidence above 1 to 100%", () => {
      render(<DerivationBadge derivation="inferred" confidence={1.5} agentResultId="ar_2" />);
      expect(screen.getByTestId("derivation-badge-inferred")).toHaveTextContent("100%");
    });

    it("clamps confidence below 0 to 0%", () => {
      render(<DerivationBadge derivation="inferred" confidence={-0.2} agentResultId="ar_2" />);
      expect(screen.getByTestId("derivation-badge-inferred")).toHaveTextContent("0%");
    });

    it("includes the raw confidence to 2 decimals and the agent run id in the tooltip", () => {
      render(<DerivationBadge derivation="inferred" confidence={0.72} agentResultId="ar_42" />);
      const badge = screen.getByTestId("derivation-badge-inferred");
      expect(badge.getAttribute("title")).toContain("0.72");
      expect(badge.getAttribute("title")).toContain("ar_42");
      expect(badge.getAttribute("aria-label")).toContain("0.72");
      expect(badge.getAttribute("aria-label")).toContain("ar_42");
    });

    it("uses the yellow Tailwind variant", () => {
      render(<DerivationBadge derivation="inferred" confidence={0.72} agentResultId="ar_2" />);
      expect(screen.getByTestId("derivation-badge-inferred").className).toMatch(/yellow/);
    });
  });

  describe("ambiguous variant", () => {
    it("renders AMBIGUOUS label with the question-mark icon", () => {
      render(<DerivationBadge derivation="ambiguous" confidence={0.4} agentResultId="ar_3" />);
      const badge = screen.getByTestId("derivation-badge-ambiguous");
      expect(badge).toHaveTextContent("AMBIGUOUS");
      // The lucide HelpCircle component has aria-hidden but its SVG is in the DOM.
      expect(badge.querySelector("svg")).toBeTruthy();
    });

    it("hides the review button when no onReview callback is supplied", () => {
      render(<DerivationBadge derivation="ambiguous" confidence={0.4} agentResultId="ar_3" />);
      expect(screen.queryByTestId("derivation-badge-review-button")).toBeNull();
    });

    it("opens a confirmation dialog and invokes onReview on confirm", async () => {
      const user = userEvent.setup();
      const onReview = vi.fn().mockResolvedValue(undefined);
      render(
        <DerivationBadge
          derivation="ambiguous"
          confidence={0.42}
          agentResultId="ar_3"
          onReview={onReview}
        />,
      );

      await user.click(screen.getByTestId("derivation-badge-review-button"));
      expect(screen.getByTestId("derivation-badge-review-dialog")).toBeInTheDocument();
      // Dialog shows raw confidence to 2 decimals.
      expect(screen.getByTestId("derivation-badge-review-dialog")).toHaveTextContent("0.42");
      // Dialog shows the agent run id.
      expect(screen.getByTestId("derivation-badge-review-dialog")).toHaveTextContent("ar_3");

      await user.click(screen.getByTestId("derivation-badge-review-confirm"));
      expect(onReview).toHaveBeenCalledTimes(1);
      expect(onReview).toHaveBeenCalledWith({
        agentResultId: "ar_3",
        confidence: 0.42,
      });
    });

    it("closes the dialog when the user clicks Cancel", async () => {
      const user = userEvent.setup();
      const onReview = vi.fn();
      render(
        <DerivationBadge
          derivation="ambiguous"
          confidence={0.4}
          agentResultId="ar_3"
          onReview={onReview}
        />,
      );
      await user.click(screen.getByTestId("derivation-badge-review-button"));
      expect(screen.getByTestId("derivation-badge-review-dialog")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: /cancel/i }));
      expect(screen.queryByTestId("derivation-badge-review-dialog")).toBeNull();
      expect(onReview).not.toHaveBeenCalled();
    });

    it("uses the orange Tailwind variant", () => {
      render(<DerivationBadge derivation="ambiguous" confidence={0.4} agentResultId="ar_3" />);
      expect(screen.getByTestId("derivation-badge-ambiguous").className).toMatch(/orange/);
    });
  });

  it("renders all three variants with distinct icons (color-blind-safe signal)", () => {
    const { rerender } = render(
      <DerivationBadge derivation="extracted" confidence={1} agentResultId="x" />,
    );
    const extractedHtml = screen.getByTestId("derivation-badge-extracted").innerHTML;

    rerender(<DerivationBadge derivation="inferred" confidence={0.7} agentResultId="x" />);
    const inferredHtml = screen.getByTestId("derivation-badge-inferred").innerHTML;

    rerender(<DerivationBadge derivation="ambiguous" confidence={0.4} agentResultId="x" />);
    const ambiguousHtml = screen.getByTestId("derivation-badge-ambiguous").innerHTML;

    // Each variant must produce different inner HTML — primarily the SVG glyph.
    expect(extractedHtml).not.toBe(inferredHtml);
    expect(extractedHtml).not.toBe(ambiguousHtml);
    expect(inferredHtml).not.toBe(ambiguousHtml);
  });
});
