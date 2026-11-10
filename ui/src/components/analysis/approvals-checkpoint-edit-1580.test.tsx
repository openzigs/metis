/**
 * Issue #1580 (`b-7-8`) — the approval checkpoint had no edit control, so
 * "edit one, then approve" had to happen on the Requirements page after the
 * requirement was already promoted. A pending requirement card now edits the
 * reviewed title and description in place.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";

const listApprovals = vi.fn();
const reviewApproval = vi.fn();
const editCheckpointRequirement = vi.fn();

vi.mock("@/lib/socket-client", () => ({ useSocket: () => null }));
vi.mock("@/lib/analysis-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/analysis-api")>();
  return {
    ...actual,
    analysisApi: {
      ...actual.analysisApi,
      listApprovals: (...args: unknown[]) => listApprovals(...args),
      reviewApproval: (...args: unknown[]) => reviewApproval(...args),
      editCheckpointRequirement: (...args: unknown[]) => editCheckpointRequirement(...args),
    },
  };
});

const { ApprovalsPanel } = await import("@/components/analysis/ApprovalsPanel");
const { checkpointEditPatch } = await import("@/components/analysis/CheckpointRequirementEditor");

const ANALYSIS_ID = "an_1580";
const TITLE = "Mark all entries older than a threshold as read";

const approval = (over: Partial<ApprovalRequestPayload> = {}): ApprovalRequestPayload => ({
  id: "ap_1",
  analysisId: ANALYSIS_ID,
  type: "requirement",
  itemId: "REQ-1",
  status: "pending",
  reviewerId: null,
  reviewNote: null,
  createdAt: "2026-10-30T00:00:00.000Z",
  reviewedAt: null,
  ...over,
});

const metadata = (requirement: Record<string, unknown> = {}) => ({
  structuredRequirements: {
    requirements: [
      {
        id: "REQ-1",
        title: TITLE,
        description: "Entries older than X are marked read.",
        ambiguities: [],
        evidenceNeeds: [],
        ...requirement,
      },
    ],
    totalAmbiguities: 0,
    totalEvidenceNeeds: 0,
  },
});

function renderPanel(meta: Record<string, unknown> = metadata()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidateSpy = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <ApprovalsPanel projectId="p1" analysisId={ANALYSIS_ID} metadata={meta} />
    </QueryClientProvider>,
  );
  return { invalidateSpy };
}

beforeEach(() => {
  vi.clearAllMocks();
  listApprovals.mockResolvedValue({
    items: [approval()],
    ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
  });
  editCheckpointRequirement.mockResolvedValue({ id: "REQ-1", title: "x", description: "" });
});

describe("#1580 — edit a requirement in the approval checkpoint", () => {
  it("opens an editor holding the reviewed text, and holds Approve and Reject while it is open", async () => {
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));

    expect(screen.getByLabelText(`Title of ${TITLE}`)).toHaveValue(TITLE);
    expect(screen.getByLabelText(`Description of ${TITLE}`)).toHaveValue(
      "Entries older than X are marked read.",
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
    // Nothing changed yet: nothing to save.
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("saves only the changed fields, trimmed, then refreshes the analysis and closes", async () => {
    const { invalidateSpy } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));

    fireEvent.change(screen.getByLabelText(`Title of ${TITLE}`), {
      target: { value: "  Mark entries published before X as read " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(editCheckpointRequirement).toHaveBeenCalledWith("p1", ANALYSIS_ID, "ap_1", {
        title: "Mark entries published before X as read",
      }),
    );
    await waitFor(() =>
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: ["analyses", "detail", ANALYSIS_ID],
      }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("checkpoint-requirement-editor")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("will not save a blank title", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));

    fireEvent.change(screen.getByLabelText(`Title of ${TITLE}`), { target: { value: "   " } });

    expect(screen.getByText("A requirement needs a title.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    // Enter in the title field submits the form, past the disabled button.
    fireEvent.submit(screen.getByTestId("checkpoint-requirement-editor"));
    // A mutation calls its function after a tick: give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
  });

  it("Cancel closes the editor without saving", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Description of ${TITLE}`), {
      target: { value: "Changed my mind." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByTestId("checkpoint-requirement-editor")).not.toBeInTheDocument();
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
    expect(screen.getByText("Entries older than X are marked read.")).toBeInTheDocument();
  });

  it("says where to edit once the approval was resolved meanwhile, and refreshes the list", async () => {
    editCheckpointRequirement.mockRejectedValue(
      new ApiError(409, "already approved", "APPROVAL_ALREADY_REVIEWED"),
    );
    const { invalidateSpy } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Description of ${TITLE}`), {
      target: { value: "Too late." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Edit it on the Requirements page/)).toHaveAttribute(
      "role",
      "alert",
    );
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["approvals", ANALYSIS_ID] });
  });

  it("offers no edit on a resolved approval", async () => {
    listApprovals.mockResolvedValue({
      items: [approval({ status: "rejected", reviewedAt: "2026-10-30T01:00:00.000Z" })],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 1 },
    });
    renderPanel();

    expect(await screen.findByRole("button", { name: `Reopen ${TITLE}` })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Edit ${TITLE}` })).not.toBeInTheDocument();
  });

  it("names the extracted title beside a retitled requirement", async () => {
    renderPanel(metadata({ title: "Bulk read-state cleanup", extractedTitle: TITLE }));

    expect(await screen.findByTestId("approval-extracted-title")).toHaveTextContent(
      `Edited. The analysis titled it: ${TITLE}`,
    );
  });
});

describe("checkpointEditPatch", () => {
  const stored = { title: "T", description: "D" };

  it("is null when nothing changed but whitespace", () => {
    expect(checkpointEditPatch(stored, " T ", "D  ")).toBeNull();
  });

  it("carries each changed field, trimmed", () => {
    expect(checkpointEditPatch(stored, "T2 ", "D")).toEqual({ title: "T2" });
    expect(checkpointEditPatch(stored, "T", "")).toEqual({ description: "" });
  });
});
