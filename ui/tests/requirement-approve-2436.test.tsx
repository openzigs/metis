/**
 * Issue #2436 — the UI side of `requirement.approve` and maker-checker:
 *
 * - the Requirements list offers Approve on `requirement.approve` and Edit on
 *   `project.update`, each disabled with its own reason, so an analyst granted
 *   one without the other gets exactly that;
 * - an author's approval refused by the server shows the server's reason;
 * - the Approval gate card carries the "Allow self-approval" switch, off by
 *   default, for review administrators only;
 * - the approval ladder and the solo-analyst outcome state the rule.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthUser } from "@/lib/auth-types";
import { ApiError } from "@/lib/api-client";
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
const gateApi = vi.hoisted(() => ({ get: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/publishing-api", async (orig) => ({
  ...((await orig()) as Record<string, unknown>),
  reviewGateApi: gateApi,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { toast } from "sonner";
import {
  APPROVE_HINT,
  EDIT_HINT,
  RequirementsList,
  REQUIREMENTS_PAGE_SIZE,
} from "@/components/requirements/requirements-list";
import {
  APPROVAL_LADDER_NOTE,
  APPROVAL_LADDER_RUNGS,
  SELF_APPROVAL_RULE,
} from "@/components/requirements/approval-ladder";
import { soloOutcome } from "@/components/reviews/request-review-card";
import {
  ApprovalGateSettingsCard,
  SELF_APPROVAL_ADMIN_ONLY,
  SELF_APPROVAL_HELP,
} from "@/components/publishing/approval-gate-card";

const SELF_APPROVAL_MESSAGE =
  "You wrote or edited this requirement, so someone else must approve it. An admin can allow self-approval in Project settings → Approval gate.";

function renderList(...permissions: Parameters<typeof userWith>) {
  const Wrapper = makeWrapper({ initialUser: userWith(...permissions) });
  return render(
    <Wrapper>
      <RequirementsList projectId="p1" />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({ items: [] });
  list.mockResolvedValue({
    items: [
      {
        id: "r-1",
        title: "Pay with a saved card",
        body: "Body",
        version: 4,
        reviewStatus: "draft",
        updatedAt: "2026-11-10T00:00:00.000Z",
        changeRequest: { id: "cr-1", title: "Checkout redesign" },
        review: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: REQUIREMENTS_PAGE_SIZE,
  });
  update.mockResolvedValue({ id: "r-1", version: 4, updatedAt: "x" });
  gateApi.get.mockResolvedValue({ requireApprovedReview: false, allowSelfApproval: false });
  gateApi.update.mockResolvedValue({ requireApprovedReview: false, allowSelfApproval: true });
});

describe("the Requirements list gates Approve and Edit separately (#2436)", () => {
  it("an analyst granted requirement.approve, without project.update, may approve but not edit", async () => {
    renderList("requirement.approve");
    const approve = await screen.findByTestId("requirements-approve-r-1");
    expect(approve).toBeEnabled();
    expect(screen.getByTestId("requirements-edit-r-1")).toBeDisabled();

    fireEvent.click(approve);
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("r-1", { reviewStatus: "approved", version: 4 }),
    );
  });

  it("one who may edit but not approve gets the converse", async () => {
    renderList("project.update");
    expect(await screen.findByTestId("requirements-approve-r-1")).toBeDisabled();
    expect(screen.getByTestId("requirements-edit-r-1")).toBeEnabled();
  });

  it("each disabled control says what it needs", () => {
    expect(APPROVE_HINT).toMatch(/requirement\.approve/);
    expect(EDIT_HINT).toMatch(/coordinator or admin/);
  });

  it("an author's refused approval shows the server's reason, not a generic failure", async () => {
    update.mockRejectedValue(new ApiError(403, SELF_APPROVAL_MESSAGE, "SELF_APPROVAL_FORBIDDEN"));
    renderList("requirement.approve");
    fireEvent.click(await screen.findByTestId("requirements-approve-r-1"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(SELF_APPROVAL_MESSAGE));
  });

  it("any other refusal keeps the generic message", async () => {
    update.mockRejectedValue(new ApiError(403, "Requires permission x", "FORBIDDEN"));
    renderList("requirement.approve");
    fireEvent.click(await screen.findByTestId("requirements-approve-r-1"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Approving the requirement failed. Try again."),
    );
  });
});

describe("the approval copy states the maker-checker rule (#2436)", () => {
  it("in the note at the point of choosing and on the direct-approval rung", () => {
    expect(APPROVAL_LADDER_NOTE).toContain(SELF_APPROVAL_RULE);
    const rung = APPROVAL_LADDER_RUNGS.find((r) => r.name === "Requirement approval");
    expect(rung?.text).toContain("requirement.approve");
    expect(rung?.text).toContain(SELF_APPROVAL_RULE);
  });

  it("in the solo outcome of anyone who may approve, not of one who may not", () => {
    expect(soloOutcome(true, true)).toContain(SELF_APPROVAL_RULE);
    expect(soloOutcome(true, false)).toContain(SELF_APPROVAL_RULE);
    expect(soloOutcome(false, false)).not.toContain(SELF_APPROVAL_RULE);
  });
});

function renderCard(role: AuthUser["role"]) {
  const Wrapper = makeWrapper({ initialUser: { ...userWith(), role } });
  return render(
    <Wrapper>
      <ApprovalGateSettingsCard projectId="p1" />
    </Wrapper>,
  );
}

describe("Allow self-approval on the Approval gate card (#2436)", () => {
  it("shows the project's setting, off by default, and what it does", async () => {
    renderCard("admin");
    await waitFor(() => expect(gateApi.get).toHaveBeenCalledWith("p1"));
    expect(screen.getByTestId("self-approval-toggle")).not.toBeChecked();
    expect(screen.getByTestId("self-approval-help")).toHaveTextContent(SELF_APPROVAL_HELP);
    expect(SELF_APPROVAL_HELP).toMatch(/audit log/);
  });

  it("an admin turns it on with a PATCH of that setting alone", async () => {
    renderCard("admin");
    await waitFor(() => expect(screen.getByTestId("self-approval-toggle")).toBeEnabled());
    await userEvent.click(screen.getByTestId("self-approval-toggle"));
    await waitFor(() =>
      expect(gateApi.update).toHaveBeenCalledWith("p1", { allowSelfApproval: true }),
    );
  });

  it("shows it on when the project allows it", async () => {
    gateApi.get.mockResolvedValue({ requireApprovedReview: false, allowSelfApproval: true });
    renderCard("admin");
    await waitFor(() => expect(screen.getByTestId("self-approval-toggle")).toBeChecked());
  });

  // #2453 — maker-checker binds a coordinator, so only an admin changes the setting.
  it("a coordinator sees it read-only, keeps the approval gate, and is told only an admin can change it", async () => {
    renderCard("coordinator");
    await waitFor(() => expect(screen.getByTestId("approval-gate-toggle")).toBeEnabled());
    expect(screen.getByTestId("self-approval-toggle")).toBeDisabled();
    expect(screen.getByTestId("self-approval-admin-only")).toHaveTextContent(
      SELF_APPROVAL_ADMIN_ONLY,
    );
    expect(SELF_APPROVAL_HELP).toMatch(/only an admin can change it/i);
  });

  it("an admin is not told it is admin-only", async () => {
    renderCard("admin");
    await waitFor(() => expect(screen.getByTestId("self-approval-toggle")).toBeEnabled());
    expect(screen.queryByTestId("self-approval-admin-only")).toBeNull();
  });

  it("a developer sees it read-only", async () => {
    renderCard("developer");
    await waitFor(() => expect(gateApi.get).toHaveBeenCalled());
    expect(screen.getByTestId("self-approval-toggle")).toBeDisabled();
  });
});
