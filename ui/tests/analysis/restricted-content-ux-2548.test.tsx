/**
 * Issue #2548 — a member who cannot read a document the run read is told why
 * its results read "Restricted", once, at the top; the Summary keeps its
 * Outcome section saying why it is hidden; the settings say web research was
 * skipped; the checks count only what the viewer can check and say why there
 * is nothing; and the run form says how many documents it leaves out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  ALL_REQUIREMENTS_RESTRICTED_MESSAGE,
  RESTRICTED_OUTCOME_BODY,
  RESTRICTED_READ_WEB_RESEARCH_NOTICE,
  RESTRICTED_RUN_NOTICE,
} from "@metis/shared";
import { makeWrapper } from "../test-utils";

const listForChangeRequest = vi.hoisted(() => vi.fn());
vi.mock("@/lib/impact-analysis-api", () => ({ impactAnalysisApi: { listForChangeRequest } }));
const listForRun = vi.hoisted(() => vi.fn());
const createPortfolio = vi.hoisted(() => vi.fn());
vi.mock("@/lib/portfolio-api", () => ({ portfolioApi: { listForRun, create: createPortfolio } }));
const capabilityPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { capabilityPreview, rename: vi.fn() },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import type { AnalysisSnapshot } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import {
  ChangeRequestSummary,
  runSettingsSummary,
} from "@/components/analysis/change-request-summary";
import { AnalysisOutcomeCard } from "@/components/analysis/AnalysisOutcomeCard";
import { analysisTabCounts } from "@/components/analysis/analysis-views";
import {
  ChangeRequestChecks,
  checkedRequirements,
  restrictedCheckCopy,
  startErrorMessage,
} from "@/components/analysis/change-request-checks";
import {
  AnalysisRunSummary,
  restrictedLeftOutLabel,
} from "@/components/analysis/analysis-run-summary";
import { documentStatusLabel, restrictedRunDocumentCount } from "@/lib/project-pipeline";
import { duplicateUploadWarning } from "@/components/projects/document-uploader";

type Req = AnalysisSnapshot["requirements"][number];
const req = (id: string, reviewStatus: string, restricted?: true) =>
  ({ id, reviewStatus, ...(restricted ? { restricted } : {}) }) as unknown as Req;

function snapshot(over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    id: "an-1",
    projectId: "p1",
    status: "completed",
    startedAt: "2026-11-01T10:00:00.000Z",
    metadata: { enhancement: { enableClarification: false, enableWebResearch: true } },
    agentResults: [],
    requirements: [],
    capability: null,
    title: "Payroll change",
    ...over,
  } as unknown as AnalysisSnapshot;
}

const renderWith = (node: React.ReactElement) => render(node, { wrapper: makeWrapper() });

beforeEach(() => {
  vi.clearAllMocks();
  listForChangeRequest.mockResolvedValue([]);
  listForRun.mockResolvedValue([]);
  capabilityPreview.mockResolvedValue({ codeConnected: true });
});

describe("the run-level notice", () => {
  it("says once, at the top, why results read Restricted for a viewer the server hid some from", () => {
    renderWith(
      <ChangeRequestSummary
        projectId="p1"
        snapshot={snapshot({ restrictedView: { narrative: true, rows: 19 } })}
        fallbackTitle="x"
        canRename={false}
      />,
    );
    expect(screen.getByTestId("change-request-restricted-notice")).toHaveTextContent(
      RESTRICTED_RUN_NOTICE,
    );
  });

  it("is absent for a viewer who sees the whole run", () => {
    renderWith(
      <ChangeRequestSummary projectId="p1" snapshot={snapshot()} fallbackTitle="x" canRename />,
    );
    expect(screen.queryByTestId("change-request-restricted-notice")).toBeNull();
  });

  it("says a run started on every document read those its starter could", () => {
    renderWith(
      <ChangeRequestSummary
        projectId="p1"
        snapshot={snapshot({
          sources: { documents: [], allDocuments: true, importedItems: [] },
        })}
        fallbackTitle="x"
        canRename={false}
      />,
    );
    expect(screen.getByTestId("change-request-sources")).toHaveTextContent(
      "all of the project's documents its starter could read",
    );
  });
});

describe("web research in the run's settings", () => {
  const on = { enhancement: { enableWebResearch: true } };
  it("reads skipped when the run withheld it (the flag every viewer gets)", () => {
    expect(runSettingsSummary({ ...on, webResearchWithheld: true }).lines).toContain(
      "Web research: skipped (restricted material)",
    );
  });

  it("reads skipped from the stored notice of a run from before the flag", () => {
    const meta = { ...on, webResearch: { notice: RESTRICTED_READ_WEB_RESEARCH_NOTICE } };
    expect(runSettingsSummary(meta).lines).toContain("Web research: skipped (restricted material)");
  });

  it("reads on when it ran, and off when it was not asked for", () => {
    expect(runSettingsSummary({ ...on, webResearch: { notice: "other" } }).lines).toContain(
      "Web research: on",
    );
    expect(
      runSettingsSummary({ enhancement: { enableWebResearch: false }, webResearchWithheld: true })
        .lines,
    ).toContain("Web research: off");
  });
});

describe("the Outcome on the Summary", () => {
  const synthesis = [{ agentKey: "synthesis", summary: null }];
  it("keeps its section, saying why, when the viewer's narrative is hidden", () => {
    render(<AnalysisOutcomeCard status="completed" agentResults={synthesis} narrativeHidden />);
    expect(screen.getByTestId("analysis-outcome-restricted")).toHaveTextContent(
      RESTRICTED_OUTCOME_BODY,
    );
    expect(screen.getByRole("heading", { name: "Outcome" })).toBeInTheDocument();
  });

  it("renders nothing when there is no synthesis, hidden or not", () => {
    const { container } = render(
      <AnalysisOutcomeCard status="completed" agentResults={[]} narrativeHidden />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the summary to a viewer who sees the run", () => {
    render(
      <AnalysisOutcomeCard
        status="completed"
        agentResults={[{ agentKey: "synthesis", summary: "All good." }]}
      />,
    );
    expect(screen.getByTestId("analysis-outcome-card")).toHaveTextContent("All good.");
    expect(screen.queryByTestId("analysis-outcome-restricted")).toBeNull();
  });
});

describe("the Requirements tab count before approval", () => {
  it("shows no number while the checkpoints hold every requirement back", () => {
    const counts = analysisTabCounts(
      snapshot({ metadata: { promotionBlocked: { blocked: true } } }),
      { pendingCount: 20 } as never,
    );
    expect(counts.requirements).toBeUndefined();
    expect(counts.approvals).toBe(20);
  });

  it("counts the stored requirements otherwise, zero included", () => {
    expect(analysisTabCounts(snapshot(), undefined).requirements).toBe(0);
    expect(
      analysisTabCounts(
        snapshot({
          metadata: { promotionBlocked: { blocked: true } },
          requirements: [req("a", "draft")],
        }),
        undefined,
      ).requirements,
    ).toBe(1);
  });
});

describe("the change request's checks", () => {
  it("counts the restricted requirements apart from those the viewer can check", () => {
    expect(
      checkedRequirements(
        snapshot({
          requirements: [req("a", "draft"), req("b", "approved", true), req("c", "rejected", true)],
        }),
      ),
    ).toEqual({ count: 1, unapproved: 1, restricted: 1 });
  });

  it("says why there is nothing to check, and how many are left out otherwise", () => {
    // One sentence, shared with the server's 400 so the two cannot drift.
    expect(restrictedCheckCopy(0, 20)).toBe(ALL_REQUIREMENTS_RESTRICTED_MESSAGE);
    expect(restrictedCheckCopy(3, 1)).toBe("1 requirement you don't have access to is left out.");
    expect(restrictedCheckCopy(3, 2)).toBe("2 requirements you don't have access to are left out.");
    expect(restrictedCheckCopy(3, 0)).toBeNull();
  });

  it("shows the server's NO_REQUIREMENTS sentence, and the generic one otherwise", () => {
    expect(startErrorMessage(new ApiError(400, "Every requirement …", "NO_REQUIREMENTS"))).toBe(
      "Every requirement …",
    );
    expect(startErrorMessage(new ApiError(500, "boom", "INTERNAL"))).toBe(
      "Could not start the portfolio check. Try again.",
    );
    expect(startErrorMessage(new Error("x"))).toBe(
      "Could not start the portfolio check. Try again.",
    );
  });

  it("offers no run when every requirement is restricted, and says why", async () => {
    renderWith(
      <ChangeRequestChecks
        projectId="p1"
        snapshot={snapshot({ requirements: [req("a", "draft", true), req("b", "draft", true)] })}
        title="Payroll change"
        canRun
      />,
    );
    expect(screen.getByTestId("change-request-checks-source")).toHaveTextContent(
      "nothing you can check",
    );
    expect(await screen.findByTestId("change-request-run-portfolio")).toBeDisabled();
  });

  it("shows the server's reason when it refuses a start for nothing to check", async () => {
    // The page's snapshot may be older than the access list: the server decides.
    createPortfolio.mockRejectedValue(
      new ApiError(400, "Every requirement of this change request draws on…", "NO_REQUIREMENTS"),
    );
    renderWith(
      <ChangeRequestChecks
        projectId="p1"
        snapshot={snapshot({ requirements: [req("a", "draft")] })}
        title="Payroll change"
        canRun
      />,
    );
    fireEvent.click(await screen.findByTestId("change-request-run-portfolio"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Every requirement of this change request draws on…",
    );
  });
});

describe("the run form", () => {
  const docs = [
    { status: "ready", source: "upload" },
    { status: "ready", source: "upload", restricted: true },
    { status: "pending", source: "upload", restricted: true },
    { status: "ready", source: "repo", restricted: true },
  ];

  it("counts the ready documents restricted from the user, not code or unready ones", () => {
    expect(restrictedRunDocumentCount(docs)).toBe(1);
  });

  it("says how many it leaves out when it reads every document", () => {
    render(
      <AnalysisRunSummary
        docCount={0}
        availableDocCount={1}
        restrictedDocCount={1}
        hasRequirements={false}
      />,
    );
    expect(screen.getByTestId("analysis-run-summary")).toHaveTextContent(
      "This run uses the project's 1 document + requirements provided: no. 1 document you don't have access to is left out.",
    );
  });

  it("says nothing of them when documents are ticked, or none is restricted", () => {
    expect(restrictedLeftOutLabel(2, 3, false)).toBeNull();
    expect(restrictedLeftOutLabel(0, 0, false)).toBeNull();
    expect(restrictedLeftOutLabel(0, 2, false)).toBe(
      "2 documents you don't have access to are left out.",
    );
    expect(restrictedLeftOutLabel(0, 2, true)).toBe(
      "At least 2 documents you don't have access to are left out.",
    );
  });
});

describe("documents", () => {
  it("one status label for both Documents pages: a quarantined one awaits review", () => {
    expect(documentStatusLabel({ status: "ready", indexState: "quarantined" })).toBe(
      "awaiting review",
    );
    expect(documentStatusLabel({ status: "ready", indexState: "indexed" })).toBe("ready");
  });

  it("warns on an upload the project already held under the same name", () => {
    expect(duplicateUploadWarning(undefined)).toBeNull();
    expect(
      duplicateUploadWarning({ id: "d1", uploadedAt: "2026-11-01T09:00:00.000Z" } as never),
    ).toMatch(
      /^This project already has this file under the same name \(uploaded .+\)\. This upload is a second copy/,
    );
    expect(duplicateUploadWarning({ uploadedAt: "not a date" })).toMatch(
      /^This project already has this file under the same name\. /,
    );
  });
});
