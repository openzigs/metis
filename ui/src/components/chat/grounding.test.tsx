/** #18 — the words a user reads about what an answer is based on. */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { GroundingBadge, UngroundedScopeNotice, coverageText, groundingText } from "./grounding";

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

describe("groundingText — why nothing was supplied (#2241)", () => {
  const nc = { status: "no-context", projectId: "p", projectName: "Payments" } as const;

  it("says the evidence was insufficient, counting the weak matches set aside", () => {
    expect(groundingText({ ...nc, reason: "insufficient-evidence", belowFloor: 8 })).toBe(
      "Insufficient evidence — nothing in Payments was relevant enough to this question (8 weak matches set aside); check any file or code it names",
    );
    expect(groundingText({ ...nc, reason: "insufficient-evidence", belowFloor: 1 })).toMatch(
      /\(1 weak match set aside\)/,
    );
    expect(groundingText({ ...nc, reason: "insufficient-evidence" })).not.toMatch(/set aside/);
  });

  it("says the search failed", () => {
    expect(groundingText({ ...nc, reason: "retrieval-failed" })).toMatch(
      /^Retrieval failed — Payments's knowledge base could not be searched/,
    );
  });

  it("keeps the plain wording when nothing was found", () => {
    expect(groundingText({ ...nc, reason: "nothing-found" })).toMatch(
      /^No excerpts from Payments were retrieved automatically/,
    );
  });
});

describe("GroundingBadge — sources and coverage (#2241)", () => {
  const grounded = {
    status: "grounded",
    projectId: "p",
    projectName: "Payments",
    sources: 3,
  } as const;

  it("lists each source with its excerpt count and relevance", () => {
    render(
      <GroundingBadge
        grounding={{
          ...grounded,
          sourcesUsed: [
            { name: "internal/feed.go", excerpts: 2, relevance: 0.713 },
            { name: "rules.md", excerpts: 1 },
          ],
        }}
      />,
    );
    const items = within(screen.getByTestId("chat-grounding-sources")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      "internal/feed.go · 2 excerpts · relevance 0.71",
      "rules.md · 1 excerpt",
    ]);
    expect(screen.getByText("Grounded in Payments · 3 sources").tagName).toBe("SUMMARY");
  });

  it("lists nothing when no sources were recorded", () => {
    render(<GroundingBadge grounding={grounded} />);
    expect(screen.queryByTestId("chat-grounding-sources")).toBeNull();
    expect(screen.getByTestId("chat-grounding").textContent).toBe(
      "Grounded in Payments · 3 sources",
    );
  });

  it("shows a partial coverage, and the reason a reply had no excerpts", () => {
    render(
      <GroundingBadge
        grounding={{
          status: "no-context",
          projectId: "p",
          projectName: "Payments",
          reason: "insufficient-evidence",
          belowFloor: 2,
          coverage: { matchingChunks: 6, totalChunks: 10 },
        }}
      />,
    );
    const badge = screen.getByTestId("chat-grounding");
    expect(badge).toHaveAttribute("data-reason", "insufficient-evidence");
    expect(badge.className).toContain("text-warning");
    expect(screen.getByTestId("chat-grounding-coverage").textContent).toBe(
      "Partial coverage — only 6 of 10 indexed sections in Payments are searchable with the current embedding model; re-index to search the rest",
    );
  });

  it("has no coverage line or reason when there is nothing to say", () => {
    expect(coverageText({ status: "unscoped" })).toBeNull();
    expect(coverageText(grounded)).toBeNull();
    render(
      <GroundingBadge grounding={{ status: "no-context", projectId: "p", projectName: "P" }} />,
    );
    expect(screen.getByTestId("chat-grounding")).not.toHaveAttribute("data-reason");
    expect(screen.queryByTestId("chat-grounding-coverage")).toBeNull();
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

describe("groundingText — multi-product (#2238)", () => {
  const alpha = { projectId: "a", projectName: "Alpha", sources: 3 };
  const beta = { projectId: "b", projectName: "Beta", sources: 1 };
  const gamma = { projectId: "c", projectName: "Gamma", sources: 0 };

  it("names each product the answer drew on, with its source count", () => {
    expect(groundingText({ status: "multi", projects: [alpha, beta] })).toBe(
      "Grounded in Alpha (3 sources), Beta (1 source)",
    );
  });

  it("names a product searched without a match, and one that could not be searched", () => {
    expect(
      groundingText({
        status: "multi",
        projects: [alpha, gamma],
        unsearched: [{ projectId: "d", projectName: "Delta", reason: "timeout" }],
        unavailable: 2,
      }),
    ).toBe(
      "Grounded in Alpha (3 sources) · nothing relevant in Gamma · Delta not searched (timed out) · 2 products no longer available to you",
    );
    expect(
      groundingText({
        status: "multi",
        projects: [alpha],
        unsearched: [{ projectId: "d", projectName: "Delta", reason: "error" }],
      }),
    ).toBe("Grounded in Alpha (3 sources) · Delta not searched (failed)");
  });

  it("says so when nothing matched, or nothing could be searched", () => {
    expect(groundingText({ status: "multi", projects: [gamma] })).toBe(
      "No excerpts matched in any product searched",
    );
    expect(groundingText({ status: "multi", projects: [] })).toMatch(
      /^Not grounded — none of this chat's products could be searched/,
    );
  });

  it("is muted only when every product was searched and one contributed", () => {
    const { rerender } = render(
      <GroundingBadge grounding={{ status: "multi", projects: [alpha, gamma] }} />,
    );
    expect(screen.getByTestId("chat-grounding").className).toContain("text-muted-foreground");
    expect(screen.getByTestId("chat-grounding")).toHaveAttribute("data-grounding", "multi");
    rerender(
      <GroundingBadge
        grounding={{
          status: "multi",
          projects: [alpha],
          unsearched: [{ projectId: "d", projectName: "Delta", reason: "timeout" }],
        }}
      />,
    );
    expect(screen.getByTestId("chat-grounding").className).toContain("text-warning");
    rerender(<GroundingBadge grounding={{ status: "multi", projects: [gamma] }} />);
    expect(screen.getByTestId("chat-grounding").className).toContain("text-warning");
    rerender(<GroundingBadge grounding={{ status: "multi", projects: [alpha], unavailable: 1 }} />);
    expect(screen.getByTestId("chat-grounding").className).toContain("text-warning");
  });
});
