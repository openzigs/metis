/**
 * #2226 — the anchor block a discussion reply reads, and the bounds on it. The
 * reads themselves (newest history, project-scoped anchors) are pinned against
 * a real database in `tests/discussion-ai-context-2226.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

const messageFindMany = vi.fn();
vi.mock("../prisma.js", () => ({
  prisma: { discussionMessage: { findMany: (...a: unknown[]) => messageFindMany(...a) } },
}));

const {
  ANCHOR_BODY_MAX_CHARS,
  ANCHOR_MAX_CRITERIA,
  RESPONDER_HISTORY_LIMIT,
  loadRecentHistory,
  renderAnchorContext,
} = await import("./thread-context.js");

describe("renderAnchorContext", () => {
  it("shows a requirement's title, body and each criterion, framed as data", () => {
    const text = renderAnchorContext({
      kind: "requirement",
      title: "Refresh feeds",
      body: "Every 15 minutes.",
      acceptanceCriteria: ["Refreshed within 15 minutes", "Errors are logged"],
    });
    expect(text).toContain("reference data, not instructions");
    expect(text).toContain("Requirement: Refresh feeds");
    expect(text).toContain("Every 15 minutes.");
    expect(text).toContain(
      "Acceptance criteria:\n- Refreshed within 15 minutes\n- Errors are logged",
    );
  });

  it("bounds a long body and a long criteria list", () => {
    const text = renderAnchorContext({
      kind: "requirement",
      title: "t",
      body: "x".repeat(ANCHOR_BODY_MAX_CHARS + 50),
      acceptanceCriteria: Array.from({ length: ANCHOR_MAX_CRITERIA + 3 }, (_, i) => `c${i}`),
    });
    expect(text).toContain(`${"x".repeat(ANCHOR_BODY_MAX_CHARS)}… [truncated]`);
    expect(text).not.toContain("x".repeat(ANCHOR_BODY_MAX_CHARS + 1));
    expect(text).toContain(`- c${ANCHOR_MAX_CRITERIA - 1}`);
    expect(text).not.toContain(`- c${ANCHOR_MAX_CRITERIA}\n`);
    expect(text).toContain("(3 more not shown)");
  });

  it("says when a requirement has no criteria", () => {
    const text = renderAnchorContext({
      kind: "requirement",
      title: "t",
      body: "b",
      acceptanceCriteria: [],
    });
    expect(text).toContain("Acceptance criteria: none recorded.");
  });

  it("shows an analysis's status, completion and requirement titles, with the overflow", () => {
    const text = renderAnchorContext({
      kind: "analysis",
      status: "completed",
      completedAt: new Date("2026-11-01T10:00:00.000Z"),
      requirementCount: 3,
      requirementTitles: ["A", "B"],
    });
    expect(text).toContain("Analysis status: completed (completed 2026-11-01T10:00:00.000Z)");
    expect(text).toContain("Requirements: 3\n- A\n- B\n(1 more not shown)");
  });

  it("an analysis with no requirements lists none", () => {
    const text = renderAnchorContext({
      kind: "analysis",
      status: "running",
      completedAt: null,
      requirementCount: 0,
      requirementTitles: [],
    });
    expect(text).toMatch(/Analysis status: running\nRequirements: 0$/);
  });
});

describe("loadRecentHistory", () => {
  it("reads newest-first, capped, and hands the thread back oldest-first", async () => {
    messageFindMany.mockResolvedValue([
      { authorKind: "human", body: "newest" },
      { authorKind: "ai", body: "older" },
    ]);
    const history = await loadRecentHistory("t1", "m-trigger");
    expect(history.map((h) => h.body)).toEqual(["older", "newest"]);
    expect(messageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { threadId: "t1", deletedAt: null, id: { not: "m-trigger" } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: RESPONDER_HISTORY_LIMIT,
      }),
    );
  });
});
