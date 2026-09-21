/**
 * Issue #607 — <ScopeDegradationNotice /> surfaces a session whose applied
 * project scope differs from what the user requested (multi-project
 * selection or a stale project id), instead of silently chatting unscoped.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScopeDegradationNotice } from "@/components/chat/scope-degradation-notice";
import type { SessionScope } from "@/lib/ai-client";

describe("<ScopeDegradationNotice />", () => {
  it("renders nothing when scope is null (session not created yet)", () => {
    const { container } = render(<ScopeDegradationNotice scope={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when the scope was applied as requested", () => {
    const scope: SessionScope = {
      requestedProjectIds: ["p1"],
      appliedProjectId: "p1",
      degraded: false,
    };
    const { container } = render(<ScopeDegradationNotice scope={scope} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("explains that multi-project scope is unsupported, with the requested count", () => {
    const scope: SessionScope = {
      requestedProjectIds: ["p1", "p2", "p3"],
      appliedProjectId: null,
      degraded: true,
      reason: "multi-project-unsupported",
    };
    render(<ScopeDegradationNotice scope={scope} />);
    const notice = screen.getByTestId("scope-degradation-notice");
    expect(notice).toHaveTextContent(/single project/i);
    expect(notice).toHaveTextContent(/3 selected projects/i);
    expect(notice).toHaveTextContent(/unscoped/i);
  });

  it("explains a stale project scope", () => {
    const scope: SessionScope = {
      requestedProjectIds: ["gone"],
      appliedProjectId: null,
      degraded: true,
      reason: "stale-project",
    };
    render(<ScopeDegradationNotice scope={scope} />);
    const notice = screen.getByTestId("scope-degradation-notice");
    expect(notice).toHaveTextContent(/no longer available/i);
    expect(notice).toHaveTextContent(/unscoped/i);
  });

  it("falls back to a generic message when degraded without a known reason", () => {
    const scope: SessionScope = {
      requestedProjectIds: ["p1"],
      appliedProjectId: null,
      degraded: true,
    };
    render(<ScopeDegradationNotice scope={scope} />);
    const notice = screen.getByTestId("scope-degradation-notice");
    expect(notice).toHaveTextContent(/unscoped/i);
  });

  it("is announced politely to assistive tech", () => {
    const scope: SessionScope = {
      requestedProjectIds: ["p1", "p2"],
      appliedProjectId: null,
      degraded: true,
      reason: "multi-project-unsupported",
    };
    render(<ScopeDegradationNotice scope={scope} />);
    expect(screen.getByRole("status")).toBeInTheDocument();
  });
});
