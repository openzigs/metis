/**
 * Issue #1587 — the requirement card's remaining `project.update` writes.
 *
 * #1566 disabled Edit, Approve and Reject for a viewer without `project.update`.
 * The same card still offered the assignee picker, the criteria-proposal
 * Accept / Dismiss (and "Keep approved criteria for all"), and the
 * source-divergence choice; the server refuses each with a 403 only after the
 * user acts. Each is now disabled, with the hint "Requires project.update",
 * for such a viewer. Every control is driven for a developer and a coordinator
 * built from `ROLE_PERMISSIONS`, with the hint derived exactly as the Analysis
 * page derives it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  ROLE_PERMISSIONS,
  type RequirementCriteriaProposal,
  type RequirementSourceDivergence,
  type RoleKey,
} from "@metis/shared";
import type { Assignment } from "@/lib/collaboration-api";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  assign: vi.fn(),
  unassign: vi.fn(),
  resolveProposal: vi.fn(),
  resolveDivergence: vi.fn(),
  dismissAll: vi.fn(),
}));
vi.mock("@/lib/collaboration-api", () => ({
  assignmentApi: { list: api.list, assign: api.assign, unassign: api.unassign },
  requirementCriteriaProposalApi: { resolve: api.resolveProposal },
  requirementSourceApi: { resolveDivergence: api.resolveDivergence },
}));
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { dismissAllCriteriaProposals: api.dismissAll },
}));
const apiFetch = vi.hoisted(() => vi.fn(async (_path: string): Promise<unknown> => []));
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AssigneePicker } from "@/components/requirements/AssigneePicker";
import { CriteriaProposalNotice } from "@/components/requirements/CriteriaProposalNotice";
import { CriteriaProposalsSummary } from "@/components/requirements/CriteriaProposalsSummary";
import { SourceDivergenceNotice } from "@/components/requirements/SourceDivergenceNotice";
import { REQUIRES_PROJECT_UPDATE } from "@/lib/permission-hints";

/** As the Analysis page derives it (#1566): a hint only without `project.update`. */
const writeHintFor = (role: RoleKey) =>
  ROLE_PERMISSIONS[role].includes("project.update") ? undefined : REQUIRES_PROJECT_UPDATE;

function renderWith(ui: ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** A disabled button takes no hover, so the hint sits on its wrapper (#945). */
function expectBlocked(button: HTMLElement) {
  expect(button).toBeDisabled();
  expect(button.closest("[data-hover-hint]")).toHaveAttribute("title", "Requires project.update");
}
function expectOpen(button: HTMLElement) {
  expect(button).toBeEnabled();
  expect(button.closest("[data-hover-hint]")).toBeNull();
}

const ASSIGNMENT: Assignment = {
  id: "as-1",
  requirementId: "req-1",
  assigneeId: "u-2",
  assignedById: "u-1",
  assignee: { id: "u-2", username: "dana", displayName: "Dana" } as Assignment["assignee"],
  assignedBy: { id: "u-1", username: "lee", displayName: "Lee" } as Assignment["assignedBy"],
  slaDeadline: null,
  resolvedAt: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  updatedAt: "2026-10-30T00:00:00.000Z",
};
const PROPOSAL: RequirementCriteriaProposal = {
  proposed: ["Starts in one second."],
  at: "2026-10-30T00:00:00.000Z",
};
const LOCAL = { title: "Export", body: "Mine", type: "feature", priority: "high", labels: [] };
const DIVERGENCE: RequirementSourceDivergence = {
  sourceFingerprint: "v1:abc",
  detectedAt: "2026-10-30T00:00:00.000Z",
  source: { ...LOCAL, body: "Theirs" },
};

beforeEach(() => {
  vi.clearAllMocks();
  api.list.mockResolvedValue([ASSIGNMENT]);
  api.unassign.mockResolvedValue(undefined);
  api.resolveProposal.mockResolvedValue({ choice: "dismiss", version: 1, changed: false });
  api.resolveDivergence.mockResolvedValue({ choice: "local", superseded: false });
  api.dismissAll.mockResolvedValue({ dismissedCount: 1 });
});

describe("#1587 — a developer cannot reach the card's project.update writes", () => {
  const hint = writeHintFor("developer");

  it("the hint is set for a developer and not for a coordinator", () => {
    expect(hint).toBe("Requires project.update");
    expect(writeHintFor("coordinator")).toBeUndefined();
  });

  it("assignee picker: Add and Remove are disabled with the hint; nothing is sent", async () => {
    renderWith(<AssigneePicker requirementId="req-1" projectId="p1" writeHint={hint} />);
    const remove = await screen.findByRole("button", { name: "Remove dana" });
    const add = screen.getByRole("button", { name: "Add assignee" });
    expectBlocked(add);
    expectBlocked(remove);
    fireEvent.click(add);
    fireEvent.click(remove);
    expect(screen.queryByPlaceholderText("Search users…")).not.toBeInTheDocument();
    expect(api.unassign).not.toHaveBeenCalled();
    expect(api.assign).not.toHaveBeenCalled();
  });

  it("criteria proposal: Accept and Dismiss are disabled; Review still opens", () => {
    renderWith(
      <CriteriaProposalNotice
        requirementId="req-1"
        title="Feed reader"
        version={1}
        proposal={PROPOSAL}
        current={["Installs as one binary."]}
        writeHint={hint}
      />,
    );
    for (const name of [
      "Accept suggested acceptance criteria for Feed reader",
      "Dismiss suggested acceptance criteria for Feed reader",
    ]) {
      const button = screen.getByRole("button", { name });
      expectBlocked(button);
      fireEvent.click(button);
    }
    expect(api.resolveProposal).not.toHaveBeenCalled();
    const review = screen.getByRole("button", {
      name: "Review suggested acceptance criteria for Feed reader",
    });
    expectOpen(review);
    fireEvent.click(review);
    expect(screen.getByRole("list", { name: "Suggested acceptance criteria" })).toBeInTheDocument();
  });

  it("criteria proposals summary: Keep approved criteria for all is disabled; Review still filters", () => {
    const onReviewChange = vi.fn();
    renderWith(
      <CriteriaProposalsSummary
        projectId="p1"
        analysisId="ana-1"
        count={2}
        reviewing={false}
        onReviewChange={onReviewChange}
        writeHint={hint}
      />,
    );
    const keepAll = screen.getByRole("button", { name: "Keep approved criteria for all" });
    expectBlocked(keepAll);
    fireEvent.click(keepAll);
    expect(api.dismissAll).not.toHaveBeenCalled();
    const review = screen.getByRole("button", { name: "Review" });
    expectOpen(review);
    fireEvent.click(review);
    expect(onReviewChange).toHaveBeenCalledWith(true);
  });

  it("source divergence: Take the source version and Keep mine are disabled; Compare still opens", () => {
    renderWith(
      <SourceDivergenceNotice
        requirementId="req-1"
        version={3}
        divergence={DIVERGENCE}
        local={LOCAL}
        writeHint={hint}
      />,
    );
    for (const name of ["Take the source version", "Keep mine"]) {
      const button = screen.getByRole("button", { name });
      expectBlocked(button);
      fireEvent.click(button);
    }
    expect(api.resolveDivergence).not.toHaveBeenCalled();
    const compare = screen.getByRole("button", { name: "Compare" });
    expectOpen(compare);
    fireEvent.click(compare);
    expect(
      screen.getByRole("table", { name: "Your version and the source's" }),
    ).toBeInTheDocument();
  });
});

describe("#1587 — a coordinator keeps every card write", () => {
  const hint = writeHintFor("coordinator");

  it("assignee picker: Add opens the search and Remove unassigns", async () => {
    renderWith(<AssigneePicker requirementId="req-1" projectId="p1" writeHint={hint} />);
    const remove = await screen.findByRole("button", { name: "Remove dana" });
    const add = screen.getByRole("button", { name: "Add assignee" });
    expectOpen(add);
    expectOpen(remove);
    fireEvent.click(add);
    expect(screen.getByPlaceholderText("Search users…")).toBeInTheDocument();
    fireEvent.click(remove);
    await waitFor(() => expect(api.unassign).toHaveBeenCalledWith("req-1", "u-2"));
  });

  it("assignee picker: a searched user is assigned; one already assigned is not", async () => {
    apiFetch.mockResolvedValue([
      { id: "u-3", username: "sam", displayName: "Sam" },
      { id: "u-2", username: "dana", displayName: "Dana" },
    ]);
    api.assign.mockResolvedValue(undefined);
    renderWith(<AssigneePicker requirementId="req-1" projectId="p1" writeHint={hint} />);
    await screen.findByRole("button", { name: "Remove dana" });
    fireEvent.click(screen.getByRole("button", { name: "Add assignee" }));
    fireEvent.change(screen.getByPlaceholderText("Search users…"), { target: { value: "sa" } });

    const already = await screen.findByRole("option", { name: /Dana/ });
    expect(already).toHaveAttribute("aria-selected", "true");
    fireEvent.click(already);
    expect(api.assign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("option", { name: /Sam/ }));
    await waitFor(() => expect(api.assign).toHaveBeenCalledWith("req-1", { assigneeId: "u-3" }));
    expect(apiFetch).toHaveBeenCalledWith("/users?search=sa&limit=8&projectId=p1");
  });

  it("criteria proposal: Dismiss is sent", async () => {
    renderWith(
      <CriteriaProposalNotice
        requirementId="req-1"
        title="Feed reader"
        version={1}
        proposal={PROPOSAL}
        current={[]}
        writeHint={hint}
      />,
    );
    const dismiss = screen.getByRole("button", {
      name: "Dismiss suggested acceptance criteria for Feed reader",
    });
    expectOpen(dismiss);
    expectOpen(
      screen.getByRole("button", { name: "Accept suggested acceptance criteria for Feed reader" }),
    );
    fireEvent.click(dismiss);
    await waitFor(() =>
      expect(api.resolveProposal).toHaveBeenCalledWith("req-1", { choice: "dismiss" }),
    );
  });

  it("criteria proposals summary: Keep approved criteria for all is sent", async () => {
    renderWith(
      <CriteriaProposalsSummary
        projectId="p1"
        analysisId="ana-1"
        count={2}
        reviewing={false}
        onReviewChange={vi.fn()}
        writeHint={hint}
      />,
    );
    const keepAll = screen.getByRole("button", { name: "Keep approved criteria for all" });
    expectOpen(keepAll);
    fireEvent.click(keepAll);
    await waitFor(() => expect(api.dismissAll).toHaveBeenCalledWith("p1", "ana-1"));
  });

  it("source divergence: Keep mine is sent", async () => {
    renderWith(
      <SourceDivergenceNotice
        requirementId="req-1"
        version={3}
        divergence={DIVERGENCE}
        local={LOCAL}
        writeHint={hint}
      />,
    );
    expectOpen(screen.getByRole("button", { name: "Take the source version" }));
    const keep = screen.getByRole("button", { name: "Keep mine" });
    expectOpen(keep);
    fireEvent.click(keep);
    await waitFor(() =>
      expect(api.resolveDivergence).toHaveBeenCalledWith("req-1", {
        choice: "local",
        sourceFingerprint: "v1:abc",
      }),
    );
  });
});
