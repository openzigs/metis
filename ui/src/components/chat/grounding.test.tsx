/** #18 — the words a user reads about what an answer is based on. */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { GroundingBadge, UngroundedScopeNotice, groundingText } from "./grounding";

describe("groundingText (#18)", () => {
  it("names the project and counts its sources", () => {
    expect(
      groundingText({ status: "grounded", projectId: "p", projectName: "Payments", sources: 3 }),
    ).toBe("Grounded in Payments · 3 sources");
    expect(
      groundingText({ status: "grounded", projectId: "p", projectName: "Payments", sources: 1 }),
    ).toBe("Grounded in Payments · 1 source");
  });

  it("#439 — counts the tool lookups that read the project, with or without excerpts", () => {
    const g = { status: "grounded", projectId: "p", projectName: "Payments" } as const;
    // #464 — a knowledge-base search counts too, so the label says "project
    // lookup", not "code lookup".
    expect(groundingText({ ...g, sources: 3, toolReads: 2 })).toBe(
      "Grounded in Payments · 3 sources · 2 project lookups",
    );
    expect(groundingText({ ...g, sources: 0, toolReads: 1 })).toBe(
      "Grounded in Payments · 1 project lookup",
    );
  });

  it("says plainly when an answer is not grounded, and why", () => {
    expect(groundingText({ status: "unscoped" })).toMatch(/^Not grounded — no project selected/);
    expect(
      groundingText({ status: "no-context", projectId: "p", projectName: "Payments" }),
    ).toMatch(/^No excerpts from Payments were retrieved automatically/);
    // Tools may have read the project, so the no-context label must not claim
    // the answer came from general knowledge (PR #437 review).
    expect(
      groundingText({ status: "no-context", projectId: "p", projectName: "Payments" }),
    ).not.toMatch(/general knowledge/);
  });
});

describe("GroundingBadge (#18)", () => {
  it("renders nothing when the grounding is not known", () => {
    const { container } = render(<GroundingBadge grounding={undefined} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("marks an ungrounded reply as a warning and a grounded one as muted", () => {
    const { rerender } = render(<GroundingBadge grounding={{ status: "unscoped" }} />);
    const badge = screen.getByTestId("chat-grounding");
    expect(badge).toHaveAttribute("data-grounding", "unscoped");
    expect(badge.className).toContain("text-warning");
    rerender(
      <GroundingBadge
        grounding={{ status: "grounded", projectId: "p", projectName: "P", sources: 2 }}
      />,
    );
    expect(screen.getByTestId("chat-grounding").className).toContain("text-muted-foreground");
  });
});

describe("UngroundedScopeNotice (#18)", () => {
  it("states that 'All projects' does not search projects", () => {
    render(<UngroundedScopeNotice show />);
    expect(screen.getByTestId("chat-ungrounded-notice").textContent).toMatch(
      /does not search your projects/,
    );
  });

  it("renders nothing when hidden", () => {
    const { container } = render(<UngroundedScopeNotice show={false} />);
    expect(container).toBeEmptyDOMElement();
  });
});
