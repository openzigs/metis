/**
 * Issue #2452 — the maker-checker refusal (#2436) is explained before the
 * click, and the self-approval setting can be found:
 *
 * - a row the server marks `selfApprovalForbidden` (the viewer wrote or edited
 *   it; the project does not allow self-approval) has Approve disabled with
 *   the reason, as a role without `requirement.approve` already had;
 * - the ladder note links straight to the setting, on Project settings;
 * - Project settings carries the Approval gate card, at that link's anchor.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper, userWith } from "./test-utils";

const list = vi.hoisted(() => vi.fn());
vi.mock("@/lib/requirements-list-api", () => ({ requirementsListApi: { list } }));
const listForProject = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analysis-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analysis-api")>()),
  analysisApi: { listForProject },
}));
const update = vi.hoisted(() => vi.fn());
vi.mock("@/lib/collaboration-api", () => ({ requirementUpdateApi: { update } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/publishing-api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reviewGateApi: {
    get: vi.fn(async () => ({ requireApprovedReview: false, allowSelfApproval: false })),
    update: vi.fn(),
  },
}));

import {
  APPROVE_HINT,
  RequirementsList,
  REQUIREMENTS_PAGE_SIZE,
  SELF_APPROVAL_HINT,
} from "@/components/requirements/requirements-list";
import {
  ApprovalLadderNote,
  approvalGateSettingsHref,
  SELF_APPROVAL_RULE,
} from "@/components/requirements/approval-ladder";

const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Requirement ${id}`,
  body: "Body",
  version: 2,
  reviewStatus: "draft",
  updatedAt: "2026-11-10T00:00:00.000Z",
  changeRequest: { id: "cr-1", title: "Checkout redesign" },
  review: null,
  ...extra,
});

function renderList(...permissions: Parameters<typeof userWith>) {
  const Wrapper = makeWrapper({ initialUser: userWith(...permissions) });
  return render(
    <Wrapper>
      <RequirementsList projectId="p1" />
    </Wrapper>,
  );
}

/** The hover hint around a control: the `title` of its wrapping span, if any. */
const hintOf = (el: HTMLElement) => el.closest("[data-hover-hint]")?.getAttribute("title") ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({ items: [] });
  list.mockResolvedValue({
    items: [row("r-mine", { selfApprovalForbidden: true }), row("r-theirs")],
    total: 2,
    page: 1,
    pageSize: REQUIREMENTS_PAGE_SIZE,
  });
  update.mockResolvedValue({ id: "r-theirs", version: 2, updatedAt: "x" });
});

describe("Approve on a row the viewer wrote (#2452)", () => {
  it("is disabled with the reason before the click; another row stays approvable", async () => {
    renderList("requirement.approve");
    const mine = await screen.findByTestId("requirements-approve-r-mine");
    expect(mine).toBeDisabled();
    expect(hintOf(mine)).toBe(SELF_APPROVAL_HINT);
    fireEvent.click(mine);
    expect(update).not.toHaveBeenCalled();

    const theirs = screen.getByTestId("requirements-approve-r-theirs");
    expect(theirs).toBeEnabled();
    expect(hintOf(theirs)).toBeNull();
    fireEvent.click(theirs);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("r-theirs", { reviewStatus: "approved", version: 2 }),
    );
  });

  it("a role without requirement.approve is told about the permission, not authorship", async () => {
    renderList("project.update");
    const mine = await screen.findByTestId("requirements-approve-r-mine");
    expect(mine).toBeDisabled();
    expect(hintOf(mine)).toBe(APPROVE_HINT);
  });

  it("the reason says who can change it and where", () => {
    expect(SELF_APPROVAL_HINT).toContain("someone else must approve it");
    expect(SELF_APPROVAL_HINT).toContain("Project settings → Approval gate");
    expect(SELF_APPROVAL_RULE).toContain("Project settings → Approval gate");
  });
});

describe("the ladder note links to the setting (#2452)", () => {
  it("on the Requirements list", async () => {
    renderList("requirement.approve");
    expect(await screen.findByTestId("approval-gate-settings-link")).toHaveAttribute(
      "href",
      "/projects/p1/settings#approval-gate",
    );
  });

  it("only when it knows the project, and with the id encoded", () => {
    const { unmount } = render(<ApprovalLadderNote />);
    expect(screen.queryByTestId("approval-gate-settings-link")).not.toBeInTheDocument();
    unmount();
    expect(approvalGateSettingsHref("a/b")).toBe("/projects/a%2Fb/settings#approval-gate");
  });
});

describe("the Approval gate card is the link's target (#2452)", () => {
  it("carries the approval-gate anchor", async () => {
    const { ApprovalGateSettingsCard } = await import("@/components/publishing/approval-gate-card");
    const Wrapper = makeWrapper({ initialUser: userWith() });
    render(
      <Wrapper>
        <ApprovalGateSettingsCard projectId="p1" />
      </Wrapper>,
    );
    expect(screen.getByTestId("approval-gate-card")).toHaveAttribute("id", "approval-gate");
    expect(approvalGateSettingsHref("p1").endsWith("#approval-gate")).toBe(true);
  });
});
