/**
 * Requirement-diff component tests — Issue #743 (Epic #728).
 *
 * Covers the rendered states: a modified requirement showing BOTH current and
 * proposed sides with the body word-diff highlighted + severity/impact badges +
 * code evidence; the empty state when there is no base run; the "no changes"
 * state; and the pure `diffWords` helper. Only `analysisApi.getRequirementDiff`
 * is mocked — the rest of analysis-api (used by CodeCitation) stays real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementDiff as TRequirementDiff } from "@metis/shared";

const getRequirementDiff = vi.fn();
vi.mock("@/lib/analysis-api", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: { getRequirementDiff: (...args: unknown[]) => getRequirementDiff(...args) },
  };
});

import { RequirementDiff, diffWords } from "./requirement-diff";

const MODIFIED: TRequirementDiff = {
  projectId: "proj-1",
  headAnalysisId: "an-head",
  baseAnalysisId: "an-base",
  entries: [
    {
      changeType: "modified",
      severity: "medium",
      impactScore: 0.55,
      diffSummary: "Body content modified (40 character delta)",
      current: {
        requirementId: "b1",
        title: "Users can log in",
        body: "Users authenticate with email and password.",
        priority: "high",
        storyPoints: 3,
        codeCitations: [{ filePath: "server/src/auth.ts", startLine: 10, endLine: 20 }],
        hasEvidence: true,
      },
      proposed: {
        requirementId: "h1",
        title: "Users can log in",
        body: "Users authenticate with email and password and lockout after failures.",
        priority: "high",
        storyPoints: 3,
        gapReport: {
          requirementId: "h1",
          title: "Users can log in",
          body: "…",
          priority: "high",
          coverage: "grounded_in_docs_only",
          verdict: "gap-confirmed",
          storyPoints: 3,
          verificationStatus: "unverified",
          currentImplementation: { hasEvidence: false, citations: [], citedFindingCount: 0 },
          gapFindings: [
            {
              id: "f-1",
              title: "No lockout",
              body: "add attempt counting",
              severity: "high",
              verificationStatus: "unverified",
              verdict: "gap-confirmed",
              citations: [],
            },
          ],
          unverifiedFindings: [],
          noEvidence: true,
        },
      },
    },
  ],
  summary: { total: 1, added: 0, removed: 0, modified: 1 },
};

function renderPanel(analyses: never[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RequirementDiff projectId="proj-1" analysisId="an-head" analyses={analyses} />
    </QueryClientProvider>,
  );
}

describe("diffWords", () => {
  it("marks inserted and deleted words and keeps common ones equal", () => {
    const tokens = diffWords("the quick fox", "the slow fox");
    expect(tokens.filter((t) => t.status === "delete").map((t) => t.text)).toContain("quick");
    expect(tokens.filter((t) => t.status === "insert").map((t) => t.text)).toContain("slow");
    expect(tokens.filter((t) => t.status === "equal").map((t) => t.text)).toEqual(
      expect.arrayContaining(["the", "fox"]),
    );
  });

  it("handles an empty current (all inserts) and an empty proposed (all deletes)", () => {
    expect(diffWords("", "new text").every((t) => t.status === "insert")).toBe(true);
    expect(diffWords("old text", "").every((t) => t.status === "delete")).toBe(true);
  });
});

describe("RequirementDiff component", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => cleanup());

  it("renders both sides, highlights changes, and shows severity + evidence", async () => {
    getRequirementDiff.mockResolvedValue(MODIFIED);
    renderPanel();

    await waitFor(() => expect(screen.getByTestId("diff-current")).toBeInTheDocument());
    expect(screen.getByTestId("diff-proposed")).toBeInTheDocument();
    expect(screen.getByTestId("diff-change-type")).toHaveTextContent("Modified");
    expect(screen.getByTestId("diff-severity")).toHaveTextContent("medium");
    // Added words highlighted on the proposed side.
    expect(screen.getAllByTestId("diff-added").length).toBeGreaterThan(0);
    // Current-implementation code citation rendered from the base gap evidence.
    expect(screen.getByText(/server\/src\/auth\.ts/)).toBeInTheDocument();
    // Proposed gap finding surfaced.
    expect(screen.getByTestId("diff-gap-finding-f-1")).toHaveTextContent("No lockout");
  });

  it("shows the no-base empty state when there is no run to compare", async () => {
    getRequirementDiff.mockResolvedValue({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: null,
      entries: [],
      summary: { total: 0, added: 0, removed: 0, modified: 0 },
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("diff-no-base")).toBeInTheDocument());
  });

  it("shows the no-changes state when a base resolved but nothing changed", async () => {
    getRequirementDiff.mockResolvedValue({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      entries: [],
      summary: { total: 0, added: 0, removed: 0, modified: 0 },
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("diff-no-changes")).toBeInTheDocument());
  });

  it("renders an added entry with no current side and a removed entry with no proposed side", async () => {
    getRequirementDiff.mockResolvedValue({
      projectId: "proj-1",
      headAnalysisId: "an-head",
      baseAnalysisId: "an-base",
      entries: [
        {
          changeType: "added",
          severity: "low",
          impactScore: 0.4,
          diffSummary: "New feature requirement added",
          current: null,
          proposed: {
            requirementId: "new-1",
            title: "Two-factor auth",
            body: "Add TOTP-based second factor.",
            priority: "high",
            storyPoints: 5,
            gapReport: null,
          },
        },
        {
          changeType: "removed",
          severity: "high",
          impactScore: 0.7,
          diffSummary: "feature requirement removed",
          current: {
            requirementId: "old-1",
            title: "Legacy SOAP endpoint",
            body: "Support the deprecated SOAP API.",
            priority: "low",
            storyPoints: 2,
            codeCitations: [],
            hasEvidence: false,
          },
          proposed: null,
        },
      ],
      summary: { total: 2, added: 1, removed: 1, modified: 0 },
    });
    renderPanel();
    await waitFor(() => expect(screen.getByTestId("diff-no-current")).toBeInTheDocument());
    expect(screen.getByTestId("diff-no-proposed")).toBeInTheDocument();
    // Removed entry's current side has no code evidence → explicit marker.
    expect(screen.getByTestId("diff-current-no-evidence")).toBeInTheDocument();
  });

  it("renders the error state when the diff request fails", async () => {
    getRequirementDiff.mockRejectedValue(new Error("boom"));
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(/Could not load the current-vs-proposed diff/)).toBeInTheDocument(),
    );
  });
});
