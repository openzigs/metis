/**
 * Issue #773 — the verdict badge is the label a BA funds work from, so the three
 * states must be unmistakably distinct and `could-not-verify` must never read like
 * a gap.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerdictBadge, VERDICT_COPY } from "./VerdictBadge";

describe("VerdictBadge", () => {
  it("renders each verdict with its own label, hue and tooltip", () => {
    for (const verdict of ["implemented", "gap-confirmed", "could-not-verify"] as const) {
      const { unmount } = render(<VerdictBadge verdict={verdict} />);
      const badge = screen.getByTestId(`verdict-badge-${verdict}`);
      expect(badge).toHaveTextContent(VERDICT_COPY[verdict].label);
      expect(badge).toHaveAttribute("title", VERDICT_COPY[verdict].tooltip);
      expect(badge).toHaveAttribute("data-verdict", verdict);
      unmount();
    }
    // Three different colours — the states are never visually conflated.
    const hues = new Set(Object.values(VERDICT_COPY).map((c) => c.className));
    expect(hues.size).toBe(3);
  });

  it("tells the reader explicitly that could-not-verify is NOT a confirmed gap", () => {
    render(<VerdictBadge verdict="could-not-verify" />);
    const badge = screen.getByTestId("verdict-badge-could-not-verify");
    expect(badge.getAttribute("title")).toMatch(/not a confirmed gap/i);
    expect(badge.getAttribute("title")).toMatch(/may well already exist/i);
  });

  it("renders nothing for a null / unknown verdict (no misleading placeholder)", () => {
    const { container } = render(<VerdictBadge verdict={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
