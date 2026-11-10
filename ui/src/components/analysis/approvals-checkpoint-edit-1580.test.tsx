/**
 * Issue #1580 (`b-7-8`) — the approval checkpoint had no edit control, so
 * "edit one, then approve" had to happen on the Requirements page after the
 * requirement was already promoted. A pending requirement card now edits the
 * reviewed title and description in place.
 */
import { act, render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ApprovalRequestPayload } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";

const listApprovals = vi.fn();
const reviewApproval = vi.fn();
const editCheckpointRequirement = vi.fn();
const approveAllApprovals = vi.fn();
const rejectAddedApprovals = vi.fn();
const reopenApproval = vi.fn();

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
      approveAllApprovals: (...args: unknown[]) => approveAllApprovals(...args),
      rejectAddedApprovals: (...args: unknown[]) => rejectAddedApprovals(...args),
      reopenApproval: (...args: unknown[]) => reopenApproval(...args),
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
  return { invalidateSpy, qc };
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
    // #2157 — a pending approval's editor takes typing.
    expect(screen.getByLabelText(`Title of ${TITLE}`)).not.toHaveAttribute("readonly");
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

  // #2157 — until the refresh lands, the card does not know how the approval
  // was resolved, so it does not say where the requirement went.
  it("says it was already reviewed on a 409, and refreshes the list to learn how", async () => {
    editCheckpointRequirement.mockRejectedValue(
      new ApiError(409, "already approved", "APPROVAL_ALREADY_REVIEWED"),
    );
    const { invalidateSpy } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Description of ${TITLE}`), {
      target: { value: "Too late." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByText(/was already reviewed/);
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).not.toHaveTextContent(/Requirements page|Reopen/);
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["approvals", ANALYSIS_ID] });
  });

  // #2147 — the 409 refresh finds the approval resolved, which moves its card to
  // Resolved. The editor, the typed text and the message used to go with it.
  it("keeps the typed text and the message when the 409 refresh finds the approval resolved", async () => {
    const approved = approval({ status: "approved", reviewedAt: "2026-10-30T01:00:00.000Z" });
    listApprovals
      .mockResolvedValueOnce({
        items: [approval()],
        ticketStatus: { allowed: false, pendingCount: 1, rejectedCount: 0 },
      })
      .mockResolvedValue({
        items: [approved],
        ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
      });
    editCheckpointRequirement.mockRejectedValue(
      new ApiError(409, "already approved", "APPROVAL_ALREADY_REVIEWED"),
    );
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Description of ${TITLE}`), {
      target: { value: "Too late." },
    });

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The refresh landed: the card is in Resolved, and the editor came with it.
    await screen.findByText("Resolved (1)");
    expect(listApprovals).toHaveBeenCalledTimes(2);
    expect(screen.getByLabelText(`Description of ${TITLE}`)).toHaveValue("Too late.");
    expect(screen.getByRole("alert")).toHaveTextContent(/Edit it on the Requirements page/);
    // #2157 — kept to copy, not to type into.
    expect(screen.getByLabelText(`Title of ${TITLE}`)).toHaveAttribute("readonly");
    expect(screen.getByLabelText(`Description of ${TITLE}`)).toHaveAttribute("readonly");
    // Nothing more to save here, and Close puts the card back as it is.
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("checkpoint-requirement-editor")).not.toBeInTheDocument();
    expect(screen.getByText("Entries older than X are marked read.")).toBeInTheDocument();
  });

  it("keeps an open edit when a refresh finds its approval resolved before any save", async () => {
    const { qc } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Title of ${TITLE}`), {
      target: { value: "Retitled while someone approved it" },
    });
    // Another reviewer approved it, and the list refreshed (a poll, a socket event).
    listApprovals.mockResolvedValue({
      items: [approval({ status: "approved", reviewedAt: "2026-10-30T01:00:00.000Z" })],
      ticketStatus: { allowed: true, pendingCount: 0, rejectedCount: 0 },
    });
    await act(() => qc.invalidateQueries({ queryKey: ["approvals", ANALYSIS_ID] }));

    await screen.findByText("Resolved (1)");
    expect(screen.getByLabelText(`Title of ${TITLE}`)).toHaveValue(
      "Retitled while someone approved it",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Edit it on the Requirements page/);
    expect(editCheckpointRequirement).not.toHaveBeenCalled();
  });

  // #2147 — a card's own Approve is held while its editor is open; Approve all
  // could not see that editor and promoted the old text after the confirm.
  it("holds Approve all while an edit is open, and says why", async () => {
    renderPanel();
    const approveAll = await screen.findByRole("button", { name: "Approve all 1 pending" });
    expect(approveAll).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: `Edit ${TITLE}` }));

    expect(approveAll).toBeDisabled();
    expect(screen.getByTestId("approve-all-edits-open")).toHaveTextContent(
      "Save or cancel the open edit first",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(approveAll).toBeEnabled();
    expect(screen.queryByTestId("approve-all-edits-open")).not.toBeInTheDocument();
  });

  it("holds the Approve all confirm when an edit opens after it was asked", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Approve all 1 pending" }));
    const confirm = screen.getByRole("button", { name: "Confirm approve all" });
    expect(confirm).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: `Edit ${TITLE}` }));

    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    // A mutation calls its function after a tick: give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(approveAllApprovals).not.toHaveBeenCalled();
  });

  it("keeps the editor open, with Save, on any other failure", async () => {
    editCheckpointRequirement
      .mockRejectedValueOnce(new ApiError(400, "Title is too long", "VALIDATION_ERROR"))
      .mockRejectedValueOnce(new Error("network down"));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Title of ${TITLE}`), { target: { value: "New" } });

    const editor = within(screen.getByTestId("checkpoint-requirement-editor"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await editor.findByRole("alert")).toHaveTextContent("Title is too long");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(editor.getByRole("alert")).toHaveTextContent("Could not save the edit. Try again."),
    );
    expect(screen.getByLabelText(`Title of ${TITLE}`)).toHaveValue("New");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
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

// #2157 — follow-ups from #2151's review.
describe("#2157 — checkpoint edits and the list-wide actions", () => {
  const OTHER = "Show unread counts per feed";
  const twoRequirements = () => ({
    structuredRequirements: {
      requirements: [
        { id: "REQ-1", title: TITLE, description: "First.", ambiguities: [], evidenceNeeds: [] },
        { id: "REQ-2", title: OTHER, description: "Second.", ambiguities: [], evidenceNeeds: [] },
      ],
      totalAmbiguities: 0,
      totalEvidenceNeeds: 0,
    },
  });
  const second = (over: Partial<ApprovalRequestPayload> = {}) =>
    approval({ id: "ap_2", itemId: "REQ-2", ...over });
  const listing = (items: ApprovalRequestPayload[]) => ({
    items,
    ticketStatus: {
      allowed: false,
      pendingCount: items.filter((a) => a.status === "pending").length,
      rejectedCount: 0,
    },
  });
  const reviewed = { reviewedAt: "2026-10-30T01:00:00.000Z" };

  it("a resolved card's kept edit does not hold Approve all for the pending ones", async () => {
    listApprovals.mockResolvedValue(listing([approval(), second()]));
    const { qc } = renderPanel(twoRequirements());
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${OTHER}` }));
    expect(screen.getByRole("button", { name: "Approve all 2 pending" })).toBeDisabled();

    // Someone approved the second one meanwhile; its card keeps the typed text.
    listApprovals.mockResolvedValue(
      listing([approval(), second({ status: "approved", ...reviewed })]),
    );
    await act(() => qc.invalidateQueries({ queryKey: ["approvals", ANALYSIS_ID] }));

    await screen.findByText("Resolved (1)");
    expect(screen.getByLabelText(`Title of ${OTHER}`)).toHaveValue(OTHER);
    expect(screen.getByRole("button", { name: "Approve all 1 pending" })).toBeEnabled();
    expect(screen.queryByTestId("approve-all-edits-open")).not.toBeInTheDocument();
  });

  it("points a rejected requirement's kept edit to Reopen, which takes it back up", async () => {
    reopenApproval.mockResolvedValue(approval());
    const { qc } = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: `Edit ${TITLE}` }));
    fireEvent.change(screen.getByLabelText(`Title of ${TITLE}`), {
      target: { value: "Retitled while someone rejected it" },
    });
    listApprovals.mockResolvedValue(listing([approval({ status: "rejected", ...reviewed })]));
    await act(() => qc.invalidateQueries({ queryKey: ["approvals", ANALYSIS_ID] }));

    await screen.findByText("Resolved (1)");
    const alert = within(screen.getByTestId("checkpoint-requirement-editor")).getByRole("alert");
    expect(alert).toHaveTextContent(/was rejected/);
    expect(alert).toHaveTextContent(/Reopen it to edit it here/);
    // A rejected requirement is left out: it is not on the Requirements page.
    expect(alert).not.toHaveTextContent(/Requirements page/);

    listApprovals.mockResolvedValue(listing([approval()]));
    fireEvent.click(screen.getByRole("button", { name: `Reopen ${TITLE}` }));

    // Pending again: the kept text is editable and can be saved.
    expect(await screen.findByRole("button", { name: "Save" })).toBeEnabled();
    expect(screen.getByLabelText(`Title of ${TITLE}`)).toHaveValue(
      "Retitled while someone rejected it",
    );
    expect(screen.getByLabelText(`Title of ${TITLE}`)).not.toHaveAttribute("readonly");
  });

  it("holds Leave out the added while an added requirement's edit is open", async () => {
    listApprovals.mockResolvedValue(
      listing([approval({ origin: "ticked" }), second({ origin: "added" })]),
    );
    renderPanel(twoRequirements());
    const leaveOut = await screen.findByRole("button", {
      name: "Leave out the 1 added by the analysis",
    });

    // An edit on a ticked item does not touch what Leave out rejects.
    fireEvent.click(screen.getByRole("button", { name: `Edit ${TITLE}` }));
    expect(leaveOut).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    fireEvent.click(screen.getByRole("button", { name: `Edit ${OTHER}` }));
    expect(leaveOut).toBeDisabled();
    expect(screen.getByTestId("leave-out-added-edits-open")).toHaveTextContent(
      "Save or cancel the open edit first",
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(leaveOut).toBeEnabled();
    expect(screen.queryByTestId("leave-out-added-edits-open")).not.toBeInTheDocument();
  });

  it("holds the Leave out confirm when an added requirement's edit opens after it was asked", async () => {
    listApprovals.mockResolvedValue(
      listing([approval({ origin: "ticked" }), second({ origin: "added" })]),
    );
    renderPanel(twoRequirements());
    fireEvent.click(
      await screen.findByRole("button", { name: "Leave out the 1 added by the analysis" }),
    );
    const confirm = screen.getByRole("button", { name: "Confirm leave out added" });
    expect(confirm).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: `Edit ${OTHER}` }));

    expect(confirm).toBeDisabled();
    // #2167 — the confirm says why, not just a greyed-out button.
    expect(
      within(screen.getByTestId("leave-out-added-confirm")).getByTestId(
        "leave-out-added-edits-open",
      ),
    ).toHaveTextContent("Save or cancel the open edit first");
    fireEvent.click(confirm);
    // A mutation calls its function after a tick: give it one.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(rejectAddedApprovals).not.toHaveBeenCalled();
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
