/**
 * Epic #609 (#619) — approval gate UI: block extraction helper, the
 * per-project settings toggle card (RBAC-gated to review.admin), and the
 * block notice rendered when a publish/export is rejected by the gate.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AuthUser } from "@/lib/auth-types";
import { ApiError } from "@/lib/api-client";
import {
  APPROVAL_GATE_UNAVAILABLE,
  APPROVAL_REQUIRED,
  extractApprovalGateBlock,
} from "@/lib/approval-gate";
import {
  ApprovalGateBlockNotice,
  ApprovalGateSettingsCard,
} from "@/components/publishing/approval-gate-card";

const { gateApi, useAuthMock } = vi.hoisted(() => ({
  gateApi: { get: vi.fn(), update: vi.fn() },
  useAuthMock: vi.fn(),
}));

vi.mock("@/lib/publishing-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, reviewGateApi: gateApi };
});

vi.mock("@/lib/auth-context", () => ({ useAuth: useAuthMock }));

function user(role: AuthUser["role"]): AuthUser {
  return {
    id: "u1",
    username: "u",
    displayName: "U",
    email: "u@x.io",
    role,
    permissions: [],
  } as AuthUser;
}

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ApprovalGateSettingsCard projectId="p1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  gateApi.get.mockResolvedValue({ requireApprovedReview: false });
  gateApi.update.mockResolvedValue({ requireApprovedReview: true });
  useAuthMock.mockReturnValue({ user: user("admin") });
});

// ---------------------------------------------------------------------------
// extractApprovalGateBlock
// ---------------------------------------------------------------------------

describe("extractApprovalGateBlock", () => {
  it("returns null for non-ApiError values", () => {
    expect(extractApprovalGateBlock(new Error("boom"))).toBeNull();
    expect(extractApprovalGateBlock(null)).toBeNull();
    expect(extractApprovalGateBlock(undefined)).toBeNull();
  });

  it("returns null for unrelated ApiError codes", () => {
    expect(
      extractApprovalGateBlock(new ApiError(409, "conflict", "REPO_CROSS_PROJECT")),
    ).toBeNull();
  });

  it("extracts a 409 APPROVAL_REQUIRED block with offending ids", () => {
    const err = new ApiError(409, "blocked", APPROVAL_REQUIRED, {
      requirementIds: ["r1", "r2"],
      unlinkedDraftIds: ["d9"],
    });
    expect(extractApprovalGateBlock(err)).toEqual({
      code: APPROVAL_REQUIRED,
      message: "blocked",
      requirementIds: ["r1", "r2"],
      unlinkedDraftIds: ["d9"],
      documentIds: [],
    });
  });

  it("extracts a 503 APPROVAL_GATE_UNAVAILABLE block (fail-closed)", () => {
    const err = new ApiError(503, "gate down", APPROVAL_GATE_UNAVAILABLE);
    expect(extractApprovalGateBlock(err)?.code).toBe(APPROVAL_GATE_UNAVAILABLE);
  });

  it("tolerates malformed details (non-array / non-string entries)", () => {
    const err = new ApiError(409, "blocked", APPROVAL_REQUIRED, {
      requirementIds: "not-an-array",
      documentIds: [1, null, "doc1"],
    } as never);
    const block = extractApprovalGateBlock(err);
    expect(block?.requirementIds).toEqual([]);
    expect(block?.documentIds).toEqual(["doc1"]);
  });
});

// ---------------------------------------------------------------------------
// ApprovalGateSettingsCard
// ---------------------------------------------------------------------------

describe("ApprovalGateSettingsCard", () => {
  it("loads and shows the current flag (default off)", async () => {
    renderCard();
    await waitFor(() => expect(gateApi.get).toHaveBeenCalledWith("p1"));
    expect(screen.getByTestId("approval-gate-toggle")).not.toBeChecked();
  });

  it("admin can toggle the gate on (PATCH with the new value)", async () => {
    renderCard();
    await waitFor(() => expect(gateApi.get).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId("approval-gate-toggle"));
    await waitFor(() =>
      expect(gateApi.update).toHaveBeenCalledWith("p1", { requireApprovedReview: true }),
    );
  });

  it("developer sees a disabled toggle and the RBAC hint", async () => {
    useAuthMock.mockReturnValue({ user: user("developer") });
    renderCard();
    await waitFor(() => expect(gateApi.get).toHaveBeenCalled());
    expect(screen.getByTestId("approval-gate-toggle")).toBeDisabled();
    expect(screen.getByText(/Only review administrators/)).toBeInTheDocument();
  });

  it("coordinator (review.admin) can toggle", async () => {
    useAuthMock.mockReturnValue({ user: user("coordinator") });
    renderCard();
    await waitFor(() => expect(screen.getByTestId("approval-gate-toggle")).not.toBeDisabled());
  });

  it("surfaces an update error", async () => {
    gateApi.update.mockRejectedValue(new ApiError(403, "permission review.admin required"));
    renderCard();
    await waitFor(() => expect(gateApi.get).toHaveBeenCalled());
    await userEvent.click(screen.getByTestId("approval-gate-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("approval-gate-toggle-error")).toHaveTextContent(
        /review.admin required/,
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// ApprovalGateBlockNotice
// ---------------------------------------------------------------------------

describe("ApprovalGateBlockNotice", () => {
  it("renders offending items and a link to the review queue", () => {
    render(
      <ApprovalGateBlockNotice
        block={{
          code: APPROVAL_REQUIRED,
          message: "Blocked by the approval gate",
          requirementIds: ["req_1"],
          unlinkedDraftIds: ["draft_9"],
          documentIds: ["doc_3"],
        }}
      />,
    );
    expect(screen.getByTestId("approval-gate-block")).toHaveTextContent("req_1");
    expect(screen.getByTestId("approval-gate-block")).toHaveTextContent("draft_9");
    expect(screen.getByTestId("approval-gate-block")).toHaveTextContent("doc_3");
    const link = screen.getByRole("link", { name: /Create or view reviews/ });
    expect(link).toHaveAttribute("href", "/reviews");
  });

  it("renders the fail-closed variant without the review link", () => {
    render(
      <ApprovalGateBlockNotice
        block={{
          code: APPROVAL_GATE_UNAVAILABLE,
          message: "gate down",
          requirementIds: [],
          unlinkedDraftIds: [],
          documentIds: [],
        }}
      />,
    );
    expect(screen.getByTestId("approval-gate-block")).toHaveTextContent(/fail-closed/);
    expect(screen.queryByRole("link", { name: /Create or view reviews/ })).toBeNull();
  });
});
