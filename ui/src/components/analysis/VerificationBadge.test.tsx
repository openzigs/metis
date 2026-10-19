/**
 * Epic #727 (#740) — VerificationBadge component tests.
 *
 * Locks the two verification states as visually + semantically distinct: each
 * renders its own label, a distinct colour class, a plain-language tooltip
 * (`title`) and an accessible name, so a non-technical BA can tell a confirmed
 * finding from an unverified one. A null/unknown status renders nothing (doc-only
 * findings + pre-#740 runs degrade gracefully).
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { VerificationBadge, VERIFICATION_COPY } from "./VerificationBadge";

describe("VerificationBadge (#740)", () => {
  it("renders confirmed with its label + tooltip + testid", () => {
    render(<VerificationBadge status="confirmed" />);
    const badge = screen.getByTestId("verification-badge-confirmed");
    expect(badge).toHaveTextContent(VERIFICATION_COPY.confirmed.label);
    expect(badge).toHaveAttribute("title", VERIFICATION_COPY.confirmed.tooltip);
    expect(badge).toHaveAttribute("data-verification", "confirmed");
  });

  it("renders unverified with actionable, cautionary tooltip copy", () => {
    render(<VerificationBadge status="unverified" />);
    const badge = screen.getByTestId("verification-badge-unverified");
    expect(badge).toHaveTextContent(VERIFICATION_COPY.unverified.label);
    // The unverified tooltip must tell the BA the claim is unproven + to review it.
    expect(badge.getAttribute("title")).toMatch(/could not|review it manually/i);
  });

  // #1155 review — a finding is also unverified when the code reference it gave
  // was unreadable and so never looked up; "every location was missing" is
  // false for that case. The copy must cover both causes.
  it("#1155 — the unverified tooltip covers both a missing and an unreadable code reference", () => {
    const tooltip = VERIFICATION_COPY.unverified.tooltip;
    expect(tooltip).not.toMatch(/every code location it cited was missing/i);
    expect(tooltip).toMatch(/not among the code the analysis read/i);
    // It is the analysis's REFERENCE that was malformed, not the code.
    expect(tooltip).toMatch(/recorded its reference to that code incorrectly/i);
    expect(tooltip).not.toMatch(/could not be read/i);
    // Sentence case: capitals read as shouting in a tooltip.
    expect(tooltip).not.toMatch(/\bNOT\b/);
    expect(tooltip).toMatch(/review it manually/i);
  });

  it("gives each state a distinct colour class (visually distinguishable)", () => {
    const classes = new Set(Object.values(VERIFICATION_COPY).map((c) => c.className));
    // Issue #773 added a THIRD state: an absence claim the run's retrieval could
    // not back. It gets its own (neutral, dashed) look — conflating it with `unverified` (a wrong
    // citation) would hide the more expensive failure mode.
    // #727 added a FOURTH: `ungrounded` (an agent with no code access).
    expect(classes.size).toBe(4);
    expect(VERIFICATION_COPY.confirmed.className).toMatch(/\bbg-success-muted\b/);
    expect(VERIFICATION_COPY.unverified.className).toMatch(/\bbg-warning-muted\b/);
    expect(VERIFICATION_COPY["could-not-verify"].className).toMatch(/\bborder-dashed\b/);
  });

  it("#773 — spells out that a could-not-verify finding is NOT a confirmed gap", () => {
    render(<VerificationBadge status="could-not-verify" />);
    const badge = screen.getByTestId("verification-badge-could-not-verify");
    expect(badge).toHaveTextContent("Could not verify");
    expect(badge.getAttribute("title")).toMatch(/not a confirmed gap/i);
  });

  it("#727 — a citation-less custom-agent finding does NOT claim it cited missing code", () => {
    render(<VerificationBadge status="ungrounded" />);
    const badge = screen.getByTestId("verification-badge-ungrounded");
    const title = badge.getAttribute("title") ?? "";
    const name = badge.getAttribute("aria-label") ?? "";
    for (const text of [title, name, badge.textContent ?? ""]) {
      expect(text).not.toMatch(/cited was missing|code location it cited|unverified/i);
    }
    expect(title).toMatch(/no access to the code/i);
    expect(title).toMatch(/nothing in it was checked against the source/i);
    expect(badge).toHaveTextContent("Not checked against code");
  });

  it("exposes an accessible name that includes the label", () => {
    render(<VerificationBadge status="unverified" />);
    expect(screen.getByRole("status", { name: /Verification: Unverified/i })).toBeInTheDocument();
  });

  it("renders nothing for a null status (doc-only / pre-#740 graceful null state)", () => {
    const { container } = render(<VerificationBadge status={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an unknown status value", () => {
    const { container } = render(<VerificationBadge status={"bogus" as unknown as null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
