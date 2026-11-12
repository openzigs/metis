/**
 * Issue #2341 — the change request's page header: its title (renamed in place),
 * what it was started from, the settings it ran with, and the eight-step header.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "../test-utils";

const rename = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { rename },
}));
const governingList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/governing-findings-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/governing-findings-api")>()),
  governingFindingsApi: { list: governingList },
}));
const productsList = vi.hoisted(() => vi.fn());
vi.mock("@/lib/products-api", () => ({ productsApi: { list: productsList } }));
const listDrafts = vi.hoisted(() => vi.fn());
vi.mock("@/lib/publishing-api", () => ({ publishingApi: { listDrafts } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ApiError } from "@/lib/api-client";
import type { AnalysisSnapshot } from "@/lib/analysis-api";
import {
  ChangeRequestSummary,
  runSettingsSummary,
} from "@/components/analysis/change-request-summary";
import { ChangeRequestStepHeader } from "@/components/analysis/change-request-step-header";

function snapshot(over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot {
  return {
    id: "an-1",
    projectId: "p1",
    startedById: "u-1",
    status: "completed",
    startedAt: "2026-11-01T10:00:00.000Z",
    completedAt: "2026-11-01T10:10:00.000Z",
    totalTokens: 0,
    errorMessage: null,
    requirementCounts: { draft: 0, approved: 0, rejected: 0, deferred: 0 },
    inputTokens: 0,
    outputTokens: 0,
    metadata: {
      agentKeys: ["document", "code"],
      model: null,
      enhancement: { enableClarification: true, enableWebResearch: false },
      structuredRequirements: { totalAmbiguities: 2 },
      startedWithDefaults: true,
    },
    agentResults: [],
    requirements: [],
    crossDocFindings: null,
    capability: null,
    affectedCode: null,
    escalation: null,
    databaseAware: null,
    sourceRequirements: [],
    title: "<script>alert(1)</script> Checkout",
    titleGenerated: false,
    sources: {
      documents: [
        { id: "d1", name: "brief.docx" },
        { id: "d2", name: null },
      ],
      allDocuments: false,
      importedItems: [
        {
          requirementId: "r1",
          title: "Saved cards",
          externalSource: "jira",
          externalId: "PAY-12",
          externalUrl: null,
        },
      ],
    },
    ...over,
  } as AnalysisSnapshot;
}

function renderWith(ui: React.ReactElement) {
  const Wrapper = makeWrapper({ withAuth: false });
  return render(<Wrapper>{ui}</Wrapper>);
}

beforeEach(() => {
  vi.clearAllMocks();
  governingList.mockResolvedValue(null);
  productsList.mockResolvedValue({ items: [], total: 0 });
  listDrafts.mockResolvedValue([]);
});

describe("ChangeRequestSummary", () => {
  it("shows the title as text, the sources and the defaults it ran with", () => {
    renderWith(
      <ChangeRequestSummary
        projectId="p1"
        snapshot={snapshot()}
        fallbackTitle="Run #1"
        canRename
      />,
    );
    const title = screen.getByTestId("change-request-title");
    expect(title).toHaveTextContent("<script>alert(1)</script> Checkout");
    expect(title.querySelector("script")).toBeNull();
    expect(screen.getByTestId("change-request-sources")).toHaveTextContent(
      "Started from: brief.docx, a document no longer in the project, PAY-12 Saved cards",
    );
    expect(screen.getByTestId("change-request-settings")).toHaveTextContent(
      "Run with defaults: Agents: document, code · Model: chosen automatically · Clarifying questions: on · Web research: off",
    );
  });

  it("says when a run read all of the project's documents, and falls back for an old payload", () => {
    renderWith(
      <ChangeRequestSummary
        projectId="p1"
        snapshot={snapshot({
          title: undefined,
          sources: { documents: [], allDocuments: true, importedItems: [] },
          metadata: { model: "claude-x" },
        })}
        fallbackTitle="Run #4 — Nov 1"
        canRename={false}
      />,
    );
    expect(screen.getByTestId("change-request-title")).toHaveTextContent("Run #4 — Nov 1");
    expect(screen.getByTestId("change-request-sources")).toHaveTextContent(
      "all of the project's documents",
    );
    expect(screen.getByTestId("change-request-settings")).toHaveTextContent(
      "Settings: Model: claude-x",
    );
    expect(screen.queryByTestId("change-request-rename")).not.toBeInTheDocument();
  });

  it("renames through the API, trimmed, and closes the editor", async () => {
    rename.mockResolvedValue({ id: "an-1", title: "Checkout v3" });
    renderWith(
      <ChangeRequestSummary projectId="p1" snapshot={snapshot()} fallbackTitle="x" canRename />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename change request" }));
    const input = screen.getByTestId("change-request-rename-input");
    expect(input).toHaveAttribute("maxLength", "200");
    fireEvent.change(input, { target: { value: "  Checkout v3 " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(rename).toHaveBeenCalledWith("p1", "an-1", "Checkout v3"));
    await waitFor(() =>
      expect(screen.queryByTestId("change-request-rename-input")).not.toBeInTheDocument(),
    );
  });

  it("sends nothing for an unchanged title and cannot save a blank one", () => {
    renderWith(
      <ChangeRequestSummary projectId="p1" snapshot={snapshot()} fallbackTitle="x" canRename />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename change request" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(rename).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Rename change request" }));
    fireEvent.change(screen.getByTestId("change-request-rename-input"), {
      target: { value: "  " },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByTestId("change-request-title")).toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    rename.mockRejectedValue(new ApiError(403, "Requires permission analysis.run", "FORBIDDEN"));
    renderWith(
      <ChangeRequestSummary projectId="p1" snapshot={snapshot()} fallbackTitle="x" canRename />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rename change request" }));
    fireEvent.change(screen.getByTestId("change-request-rename-input"), {
      target: { value: "Mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Requires permission analysis.run");
  });

  it("runSettingsSummary reads nothing from no metadata", () => {
    expect(runSettingsSummary(null)).toEqual({
      defaults: false,
      lines: ["Model: chosen automatically", "Clarifying questions: off", "Web research: off"],
    });
  });
});

describe("ChangeRequestStepHeader", () => {
  it("lists the eight steps as links in order, each state in words", async () => {
    const agentResults = [
      { agentKey: "document", status: "completed" },
      { agentKey: "code", status: "completed" },
    ] as AnalysisSnapshot["agentResults"];
    renderWith(
      <ChangeRequestStepHeader
        projectId="p1"
        snapshot={snapshot({ agentResults })}
        pendingApprovals={0}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Change request steps" });
    // Until the drafts are read, Hand-off is not known; then it is a state.
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-handoff")).toHaveAttribute(
        "data-state",
        "not-started",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-policy")).toHaveAttribute(
        "data-state",
        "not-applicable",
      ),
    );
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => l.textContent?.split(":")[0])).toEqual([
      "1. ReadDone",
      "2. QuestionsNeeds you",
      "3. RequirementsNeeds you",
      "4. Policy checkNot applicable",
      "5. ImpactDone",
      // The portfolio is empty (total 0), so its step does not apply.
      "6. PortfolioNot applicable",
      "7. ReviewNot started",
      "8. Hand-offNot started",
    ]);
    // The first step that needs the analyst is the current one.
    expect(screen.getByTestId("change-request-step-questions")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByTestId("change-request-step-questions")).toHaveAttribute(
      "href",
      "/projects/p1/analysis?analysisId=an-1&tab=questions",
    );
    // Once the portfolio is known to be empty, its step does not apply.
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-portfolio")).toHaveAttribute(
        "data-state",
        "not-applicable",
      ),
    );
  });

  it("reads policy findings and this run's published drafts", async () => {
    governingList.mockResolvedValue({
      findings: [{ status: "needs-ba-input" }, { status: "compliant" }],
      revisions: [],
      refreshing: false,
      checked: true,
    });
    productsList.mockResolvedValue({ items: [], total: 2 });
    listDrafts.mockResolvedValue([
      { id: "dr-1", requirementId: "req-1", status: "published" },
      { id: "dr-2", requirementId: "req-other-run", status: "draft" },
    ]);
    renderWith(
      <ChangeRequestStepHeader
        projectId="p1"
        snapshot={snapshot({
          requirements: [
            { id: "req-1", reviewStatus: "approved" },
          ] as AnalysisSnapshot["requirements"],
        })}
        pendingApprovals={undefined}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-policy")).toHaveAttribute(
        "data-state",
        "needs-you",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-handoff")).toHaveAttribute(
        "data-state",
        "done",
      ),
    );
    expect(screen.getByTestId("change-request-step-review")).toHaveAttribute("data-state", "done");
    expect(screen.getByTestId("change-request-step-portfolio")).toHaveTextContent("Not started");
  });

  it("treats a payload of an unexpected shape as not known", async () => {
    governingList.mockResolvedValue({ unexpected: true });
    productsList.mockResolvedValue({});
    listDrafts.mockResolvedValue({ not: "an array" });
    renderWith(
      <ChangeRequestStepHeader projectId="p1" snapshot={snapshot()} pendingApprovals={0} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("change-request-step-handoff")).toHaveAttribute(
        "data-state",
        "unknown",
      ),
    );
    expect(screen.getByTestId("change-request-step-policy")).toHaveAttribute(
      "data-state",
      "unknown",
    );
  });

  it("reads 'Unknown' while the facts load, never a state", () => {
    governingList.mockReturnValue(new Promise(() => {}));
    listDrafts.mockReturnValue(new Promise(() => {}));
    renderWith(
      <ChangeRequestStepHeader projectId="p1" snapshot={snapshot()} pendingApprovals={0} />,
    );
    const policy = screen.getByTestId("change-request-step-policy");
    expect(policy).toHaveAttribute("data-state", "unknown");
    expect(policy).toHaveTextContent("Unknown");
    expect(policy).toHaveAttribute("title", "Checking the policy findings…");
    expect(screen.getByTestId("change-request-step-handoff")).toHaveAttribute(
      "data-state",
      "unknown",
    );
  });

  it("a failed governing-findings read says it couldn't check, never that the policy check is off", async () => {
    governingList.mockRejectedValue(new ApiError(500, "boom", "INTERNAL"));
    renderWith(
      <ChangeRequestStepHeader projectId="p1" snapshot={snapshot()} pendingApprovals={0} />,
    );
    const policy = screen.getByTestId("change-request-step-policy");
    await waitFor(() =>
      expect(policy).toHaveAttribute("title", "Couldn't check the policy findings."),
    );
    expect(policy).toHaveAttribute("data-state", "unknown");
    expect(policy).toHaveTextContent("Unknown");
    expect(policy).not.toHaveTextContent("Not applicable");
    expect(policy).not.toHaveTextContent("The policy check is off");
  });

  it("drafts refused (403, no issue.draft) leave Hand-off unknown, not 'Not started'", async () => {
    listDrafts.mockRejectedValue(new ApiError(403, "Requires permission issue.draft", "FORBIDDEN"));
    renderWith(
      <ChangeRequestStepHeader
        projectId="p1"
        snapshot={snapshot({
          requirements: [
            { id: "req-1", reviewStatus: "approved" },
          ] as AnalysisSnapshot["requirements"],
        })}
        pendingApprovals={0}
      />,
    );
    const handoff = screen.getByTestId("change-request-step-handoff");
    await waitFor(() =>
      expect(handoff).toHaveAttribute("title", "Couldn't check the issue drafts."),
    );
    expect(handoff).toHaveAttribute("data-state", "unknown");
    expect(handoff).toHaveTextContent("Unknown");
    expect(handoff).not.toHaveTextContent("Not started");
  });
});
