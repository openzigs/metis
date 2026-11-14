/**
 * Issue #2447 — a requirement the viewer cannot see a source of arrives as the
 * server's placeholder (`restricted: true`, title "Restricted"). The UI shows
 * it in place, says why, and offers none of the actions the server would
 * refuse: on the Requirements list (no Approve, Edit or review pick) and on
 * the change request page (a card with no actions at all).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
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
    get: vi.fn(async () => ({ requireApprovedReview: false, allowSelfApproval: true })),
    update: vi.fn(),
  },
}));

import {
  RequirementsList,
  REQUIREMENTS_PAGE_SIZE,
  RESTRICTED_REQUIREMENT_HINT,
} from "@/components/requirements/requirements-list";
import { RestrictedRequirementCard } from "@/components/requirements/restricted-requirement-card";

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

/** The hover hint around a control: the `title` of its wrapping span, if any. */
const hintOf = (el: HTMLElement) => el.closest("[data-hover-hint]")?.getAttribute("title") ?? null;

beforeEach(() => {
  vi.clearAllMocks();
  listForProject.mockResolvedValue({ items: [] });
  list.mockResolvedValue({
    items: [
      row("r-hidden", { title: "Restricted", restricted: true }),
      row("r-open", { title: "Customers can pay" }),
    ],
    total: 2,
    page: 1,
    pageSize: REQUIREMENTS_PAGE_SIZE,
  });
});

describe("a restricted requirement on the Requirements list (#2447)", () => {
  it("keeps its row, with Approve and Edit disabled and the reason, and no review pick", async () => {
    const Wrapper = makeWrapper({
      initialUser: userWith("requirement.approve", "project.update", "review.create"),
    });
    render(
      <Wrapper>
        <RequirementsList projectId="p1" />
      </Wrapper>,
    );
    const approve = await screen.findByTestId("requirements-approve-r-hidden");
    expect(approve).toBeDisabled();
    expect(hintOf(approve)).toBe(RESTRICTED_REQUIREMENT_HINT);
    fireEvent.click(approve);
    expect(update).not.toHaveBeenCalled();
    const edit = screen.getByTestId("requirements-edit-r-hidden");
    expect(edit).toBeDisabled();
    expect(hintOf(edit)).toBe(RESTRICTED_REQUIREMENT_HINT);
    expect(screen.queryByLabelText("Choose Restricted for a review")).toBeNull();

    // The row the viewer can see is untouched.
    expect(screen.getByTestId("requirements-approve-r-open")).toBeEnabled();
    expect(screen.getByTestId("requirements-edit-r-open")).toBeEnabled();
    expect(hintOf(screen.getByTestId("requirements-edit-r-open"))).toBeNull();
    expect(screen.getByLabelText("Choose Customers can pay for a review")).toBeInTheDocument();
  });
});

describe("a restricted requirement on the change request page (#2447)", () => {
  it("is a card with its placeholder text and status, and no action", () => {
    render(
      <RestrictedRequirementCard
        requirement={{
          id: "r-hidden",
          title: "Restricted",
          body: "This draws on sources you don't have access to, so its content is hidden.",
          type: "feature",
          priority: "high",
          reviewStatus: "draft",
        }}
      />,
    );
    const card = screen.getByTestId("req-restricted-r-hidden");
    expect(card).toHaveTextContent("Restricted");
    expect(card).toHaveTextContent("feature · high · draft");
    expect(card).toHaveTextContent("don't have access");
    expect(card.querySelector("button, input, a")).toBeNull();
  });
});
