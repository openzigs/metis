/**
 * Epic #609 / Issue #620 — baseline UI component tests: contents table
 * (as-of-pin rendering + drift notes), compare view (added / removed /
 * changed with field-level diff / unchanged), and the list-page summary
 * helper.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  BaselineItemsTable,
  describeDrift,
  snapshotMeta,
} from "@/components/baselines/BaselineItemsTable";
import { BaselineCompareView, compareSummary } from "@/components/baselines/BaselineCompareView";
import { summarizeBaseline } from "@/app/(authed)/projects/[id]/baselines/page";
import type { BaselineCompareResult, BaselineItem, BaselineSummary } from "@/lib/baselines-api";

// ---- Fixtures -----------------------------------------------------------------

function makeItem(overrides: Partial<BaselineItem> = {}): BaselineItem {
  return {
    requirementId: "req-1",
    version: 2,
    snapshot: {
      title: "Login must support SSO",
      body: "As a user…",
      priority: "medium",
      type: "functional",
      labels: null,
      storyPoints: 5,
    },
    current: { version: 2, deleted: false },
    ...overrides,
  };
}

function makeCompareResult(overrides: Partial<BaselineCompareResult> = {}): BaselineCompareResult {
  return {
    baselineA: { id: "base-a", name: "Sprint 4", createdAt: "2026-07-01T00:00:00Z" },
    baselineB: { id: "base-b", name: "Sprint 5", createdAt: "2026-07-02T00:00:00Z" },
    added: [{ requirementId: "req-3", version: 1, title: "New requirement" }],
    removed: [{ requirementId: "req-2", version: 1, title: "Dropped requirement" }],
    changed: [
      {
        requirementId: "req-1",
        fromVersion: 2,
        toVersion: 3,
        title: "Login must support SSO",
        changedFields: { priority: { from: "medium", to: "high" } },
      },
    ],
    unchanged: [{ requirementId: "req-4", version: 7, title: "Stable requirement" }],
    ...overrides,
  };
}

function makeSummary(overrides: Partial<BaselineSummary> = {}): BaselineSummary {
  return {
    id: "base-a",
    projectId: "proj-1",
    reviewRequestId: "rev-1",
    name: "Sprint 4 sign-off",
    description: "",
    createdAt: "2026-07-01T00:00:00Z",
    createdBy: { id: "u1", username: "bob", displayName: "Bob" },
    reviewRequest: { id: "rev-1", title: "Sprint 4 sign-off", status: "approved" },
    itemCount: 3,
    ...overrides,
  };
}

// ---- describeDrift / snapshotMeta ------------------------------------------------

describe("describeDrift", () => {
  it("returns null when the requirement still sits at the pinned version", () => {
    expect(describeDrift(makeItem())).toBeNull();
  });

  it("reports drift when the requirement moved on", () => {
    expect(describeDrift(makeItem({ current: { version: 5, deleted: false } }))).toBe("now at v5");
  });

  it("reports deletion", () => {
    expect(describeDrift(makeItem({ current: { version: 2, deleted: true } }))).toBe(
      "deleted since (was v2)",
    );
  });

  it("reports a missing requirement row", () => {
    expect(describeDrift(makeItem({ current: null }))).toBe("requirement no longer exists");
  });
});

describe("snapshotMeta", () => {
  it("joins type, priority, and story points", () => {
    expect(snapshotMeta(makeItem())).toBe("functional · priority medium · 5 pts");
  });

  it("omits absent fields and handles a null snapshot", () => {
    expect(
      snapshotMeta(
        makeItem({
          snapshot: {
            title: "T",
            body: null,
            priority: null,
            type: null,
            labels: null,
            storyPoints: null,
          },
        }),
      ),
    ).toBe("");
    expect(snapshotMeta(makeItem({ snapshot: null }))).toBe("");
  });
});

// ---- BaselineItemsTable ------------------------------------------------------------

describe("BaselineItemsTable", () => {
  it("renders pinned snapshots with version badges and drift notes", () => {
    render(
      <BaselineItemsTable
        items={[
          makeItem(),
          makeItem({ requirementId: "req-2", version: 1, current: { version: 4, deleted: false } }),
        ]}
      />,
    );
    expect(screen.getAllByText("Login must support SSO")).toHaveLength(2);
    expect(screen.getByText("v2")).toBeInTheDocument();
    expect(screen.getByText("now at v4")).toBeInTheDocument();
  });

  // Issue #998 — pinned bodies printed raw Markdown and METIS's block markers.
  it("renders a pinned body as Markdown and hides the metis: markers", () => {
    const body = [
      "### Summary",
      "",
      "Users can **export** feeds.",
      "",
      "<!-- metis:clarifications:start -->",
      "## Clarifications",
      "",
      "- **Q:** Which format?",
      "  **A:** OPML",
      "",
      "> **Check the acceptance criteria.** Edit them. <!-- metis:criteria-predate-answers -->",
      "<!-- metis:clarifications:end -->",
    ].join("\n");
    const item = makeItem();
    render(<BaselineItemsTable items={[{ ...item, snapshot: { ...item.snapshot!, body } }]} />);
    const card = screen.getByTestId("baseline-item-req-1");
    expect(screen.getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Clarifications" })).toBeInTheDocument();
    expect(screen.getByText("export").tagName).toBe("STRONG");
    expect(card.querySelector("blockquote")).not.toBeNull();
    expect(card.textContent).not.toContain("metis:");
    expect(card.textContent).not.toMatch(/\*\*|##|<!--/);
  });

  it("does not turn raw HTML in a pinned body into markup", () => {
    const item = makeItem();
    const body = 'Hi <img src=x onerror="alert(1)"> <script>alert(2)</script> there';
    const { container } = render(
      <BaselineItemsTable items={[{ ...item, snapshot: { ...item.snapshot!, body } }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    // Pins `skipHtml`: without it the tags are printed as text (see RequirementBody.test).
    const text = screen.getByTestId("requirement-body").textContent ?? "";
    expect(text).not.toContain("<");
    expect(text).not.toContain("onerror");
  });

  it("does not load a remote image from a pinned body", () => {
    const item = makeItem();
    const body = "Layout: ![wireframe](https://tracker.example/pixel.png)";
    const { container } = render(
      <BaselineItemsTable items={[{ ...item, snapshot: { ...item.snapshot!, body } }]} />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("link", { name: "wireframe" })).toHaveAttribute(
      "href",
      "https://tracker.example/pixel.png",
    );
  });

  it("breaks a long unbroken token in a pinned body", () => {
    const item = makeItem();
    const body = `sha256:${"0123456789abcdef".repeat(12)}`;
    render(<BaselineItemsTable items={[{ ...item, snapshot: { ...item.snapshot!, body } }]} />);
    expect(screen.getByTestId("requirement-body")).toHaveClass("break-words");
  });

  it("renders an empty state", () => {
    render(<BaselineItemsTable items={[]} />);
    expect(screen.getByText(/pins no requirements/i)).toBeInTheDocument();
  });

  it("falls back to the requirement id when no snapshot exists", () => {
    render(<BaselineItemsTable items={[makeItem({ snapshot: null, current: null })]} />);
    expect(screen.getByText("req-1")).toBeInTheDocument();
    expect(screen.getByText("requirement no longer exists")).toBeInTheDocument();
  });
});

// ---- BaselineCompareView -------------------------------------------------------------

describe("compareSummary", () => {
  it("summarizes bucket counts", () => {
    expect(compareSummary(makeCompareResult())).toBe(
      "1 added · 1 removed · 1 changed · 1 unchanged",
    );
  });
});

describe("BaselineCompareView", () => {
  it("renders added, removed, changed (with field diff), and unchanged sections", () => {
    render(<BaselineCompareView result={makeCompareResult()} />);
    expect(screen.getByText("Sprint 4 → Sprint 5")).toBeInTheDocument();
    expect(screen.getByTestId("compare-added")).toHaveTextContent("New requirement");
    expect(screen.getByTestId("compare-removed")).toHaveTextContent("Dropped requirement");
    expect(screen.getByTestId("compare-unchanged")).toHaveTextContent("Stable requirement");
    const changed = screen.getByTestId("compare-changed-req-1");
    expect(changed).toHaveTextContent("v2 → v3");
    // Field-level diff rendered via the shared VersionDiff component.
    expect(screen.getByTestId("diff-field-priority")).toHaveTextContent("medium");
    expect(screen.getByTestId("diff-field-priority")).toHaveTextContent("high");
  });

  it("omits empty sections", () => {
    render(
      <BaselineCompareView
        result={makeCompareResult({ added: [], removed: [], changed: [], unchanged: [] })}
      />,
    );
    expect(screen.queryByTestId("compare-added")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compare-removed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compare-changed")).not.toBeInTheDocument();
    expect(screen.queryByTestId("compare-unchanged")).not.toBeInTheDocument();
  });
});

// ---- summarizeBaseline ----------------------------------------------------------------

describe("summarizeBaseline", () => {
  it("summarizes a review-produced baseline", () => {
    expect(summarizeBaseline(makeSummary())).toContain('3 pins · from review "Sprint 4 sign-off"');
  });

  it("summarizes a manual baseline with singular pin count", () => {
    expect(summarizeBaseline(makeSummary({ itemCount: 1, reviewRequest: null }))).toContain(
      "1 pin · manual, by Bob",
    );
  });

  it("omits an unparseable creation date", () => {
    const summary = summarizeBaseline(makeSummary({ createdAt: "not-a-date" }));
    expect(summary).not.toContain("created");
  });
});
