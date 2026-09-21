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

  it("gives each state a distinct colour class (visually distinguishable)", () => {
    const classes = new Set(Object.values(VERIFICATION_COPY).map((c) => c.className));
    // Issue #773 added a THIRD state: an absence claim the run's retrieval could
    // not back. It gets its own hue — conflating it with `unverified` (a wrong
    // citation) would hide the more expensive failure mode.
    expect(classes.size).toBe(3);
    expect(VERIFICATION_COPY.confirmed.className).toMatch(/emerald/);
    expect(VERIFICATION_COPY.unverified.className).toMatch(/amber/);
    expect(VERIFICATION_COPY["could-not-verify"].className).toMatch(/violet/);
  });

  it("#773 — spells out that a could-not-verify finding is NOT a confirmed gap", () => {
    render(<VerificationBadge status="could-not-verify" />);
    const badge = screen.getByTestId("verification-badge-could-not-verify");
    expect(badge).toHaveTextContent("Could not verify");
    expect(badge.getAttribute("title")).toMatch(/not a confirmed gap/i);
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
