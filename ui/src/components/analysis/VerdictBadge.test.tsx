/**
 * Issue #773 — the verdict badge is the label a BA funds work from, so the three
 * states must be unmistakably distinct and `could-not-verify` must never read like
 * a gap.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { UNKNOWN_VERDICT_COPY, VerdictBadge, VERDICT_COPY } from "./VerdictBadge";

describe("VerdictBadge", () => {
  it("renders each verdict with its own label, hue and tooltip", () => {
    for (const verdict of [
      "implemented",
      "partial",
      "gap-confirmed",
      "could-not-verify",
    ] as const) {
      const { unmount } = render(<VerdictBadge verdict={verdict} />);
      const badge = screen.getByTestId(`verdict-badge-${verdict}`);
      expect(badge).toHaveTextContent(VERDICT_COPY[verdict].label);
      expect(badge).toHaveAttribute("title", VERDICT_COPY[verdict].tooltip);
      expect(badge).toHaveAttribute("data-verdict", verdict);
      unmount();
    }
    // A different colour per state — the states are never visually conflated.
    const hues = new Set(Object.values(VERDICT_COPY).map((c) => c.className));
    expect(hues.size).toBe(4);
  });

  it("#1610 — says partial means part of it exists and only the rest needs building", () => {
    render(<VerdictBadge verdict="partial" />);
    const badge = screen.getByTestId("verdict-badge-partial");
    expect(badge).toHaveTextContent("Partly implemented");
    expect(badge.getAttribute("aria-label")).toMatch(/^Verdict: Partly implemented\./);
    expect(badge.getAttribute("title")).toMatch(/backed by cited code/i);
    expect(badge.getAttribute("title")).toMatch(/confirmed a gap/i);
  });

  it("#1615 — a partial requirement renders the partial badge, not the gap or implemented one", () => {
    render(<VerdictBadge verdict="partial" />);
    expect(screen.getByTestId("verdict-badge-partial")).toBeInTheDocument();
    expect(screen.queryByTestId("verdict-badge-gap-confirmed")).toBeNull();
    expect(screen.queryByTestId("verdict-badge-implemented")).toBeNull();
    expect(screen.getByRole("status")).not.toHaveTextContent(/gap confirmed|^implemented$/i);
  });

  it("#1615 — the partial tooltip promises nothing the gap report does not show", () => {
    // The gap report has no per-criterion met/unmet view (criterionEvidence is
    // not on the snapshot), so the tooltip must not send the BA there for it.
    expect(VERDICT_COPY.partial.tooltip).not.toMatch(/which criteria are met/i);
  });

  it("#1615 — an unknown future verdict renders the neutral state, not a crash", () => {
    render(<VerdictBadge verdict={"mostly-done" as never} />);
    const badge = screen.getByTestId("verdict-badge-unknown");
    expect(badge).toHaveTextContent(UNKNOWN_VERDICT_COPY.label);
    expect(badge).toHaveAttribute("data-verdict", "unknown");
    expect(badge.className).toContain("bg-muted");
    // Never borrows a real verdict's colour or words.
    for (const copy of Object.values(VERDICT_COPY)) {
      expect(badge.className).not.toBe(copy.className);
      expect(badge).not.toHaveTextContent(copy.label);
    }
  });

  it("tells the reader explicitly that could-not-verify is NOT a confirmed gap", () => {
    render(<VerdictBadge verdict="could-not-verify" />);
    const badge = screen.getByTestId("verdict-badge-could-not-verify");
    expect(badge.getAttribute("title")).toMatch(/not a confirmed gap/i);
    expect(badge.getAttribute("title")).toMatch(/may well already exist/i);
  });

  it("renders nothing for a null / absent verdict (no misleading placeholder)", () => {
    const { container } = render(<VerdictBadge verdict={null} />);
    expect(container).toBeEmptyDOMElement();
    const { container: absent } = render(<VerdictBadge verdict={undefined} />);
    expect(absent).toBeEmptyDOMElement();
  });
});
