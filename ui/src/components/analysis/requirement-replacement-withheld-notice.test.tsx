/**
 * Issue #769 — when a re-synthesis (e.g. after Regenerate) was refused
 * permission to replace a reviewed or healthy requirement set, the user is told
 * the set was kept and why, instead of the Regenerate appearing to do nothing.
 *
 * Issue #780 — and, when the refused result was kept, can review what it would
 * change, then apply it (after a confirmation naming the reviewed requirements
 * it rewords) or dismiss it.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WithheldReplacementDiff } from "@metis/shared";

const api = vi.hoisted(() => ({
  getWithheldReplacement: vi.fn(),
  applyWithheldReplacement: vi.fn(),
  dismissWithheldReplacement: vi.fn(),
}));
vi.mock("@/lib/analysis-api", () => ({ analysisApi: api }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
const auth = vi.hoisted(() => ({ role: "coordinator", permissions: ["project.update"] }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: auth }) }));

import { ApiError } from "@/lib/api-client";
import {
  RequirementReplacementWithheldNotice,
  summarizeWithheldReplacement,
} from "@/components/analysis/RequirementReplacementWithheldNotice";

const withheld = {
  reason: "reviewed-work" as const,
  existingCount: 25,
  reviewedCount: 4,
  proposedCount: 30,
  at: "2026-10-02T00:37:14.000Z",
};

const DIFF: WithheldReplacementDiff = {
  withheld: { ...withheld, proposalStored: true },
  fingerprint: "fp-1",
  added: [
    {
      title: "Export feeds as OPML",
      outcome: "add",
      reviewed: false,
      reviewStatus: null,
      changes: [],
      proposed: {
        type: "feature",
        priority: "high",
        description: "Users can export their feeds.",
        acceptanceCriteria: ["An OPML file downloads."],
      },
    },
  ],
  changed: [
    {
      title: "Feed listing",
      outcome: "update",
      reviewed: true,
      reviewStatus: "approved",
      changes: [
        { field: "description", before: "Lists feeds.", after: "Lists feeds, 100 per page." },
        { field: "acceptanceCriteria", before: [], after: ["Pages hold 100 feeds."] },
      ],
    },
    {
      title: "Login",
      outcome: "replace",
      reviewed: false,
      reviewStatus: null,
      changes: [{ field: "priority", before: "low", after: "high" }],
    },
  ],
  removed: [
    { title: "Old import", outcome: "delete", reviewed: false, reviewStatus: null, changes: [] },
    { title: "Dark mode", outcome: "keep", reviewed: true, reviewStatus: null, changes: [] },
  ],
  skipped: [
    { title: "Telemetry", outcome: "skip", reviewed: true, reviewStatus: null, changes: [] },
  ],
  unchangedCount: 3,
};

const KEY = ["analyses", "detail", "an-1"];

function renderActionable(meta: Record<string, unknown> = { ...withheld, proposalStored: true }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <RequirementReplacementWithheldNotice
        metadata={{ requirementReplacementWithheld: meta }}
        projectId="p-1"
        analysisId="an-1"
        invalidateKeys={[KEY]}
      />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("RequirementReplacementWithheldNotice", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
    auth.role = "coordinator";
    auth.permissions = ["project.update"];
  });

  /** Open the comparison, then ask to dismiss: the confirmation that follows. */
  async function openDismissConfirmation() {
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Dismiss changes" }));
    return screen.findByRole("alertdialog", { name: "Dismiss the new result?" });
  }

  it("renders nothing when no replacement was withheld", () => {
    for (const metadata of [{}, null, undefined, { requirementReplacementWithheld: "x" }]) {
      expect(
        render(<RequirementReplacementWithheldNotice metadata={metadata} />).container,
      ).toBeEmptyDOMElement();
    }
  });

  it("says the reviewed set was kept and the new synthesis not applied", () => {
    render(
      <RequirementReplacementWithheldNotice
        metadata={{ requirementReplacementWithheld: withheld }}
      />,
    );
    const notice = screen.getByTestId("requirement-replacement-withheld");
    expect(notice).toHaveTextContent(/kept the existing 25 requirements/);
    expect(notice).toHaveTextContent(/4 of them carry review work/);
    expect(notice).toHaveTextContent(/30 newly synthesized requirements were not applied/);
    expect(screen.getByRole("status")).toHaveTextContent(/kept the existing/);
  });

  it("explains a refused degraded synthesis", () => {
    render(
      <RequirementReplacementWithheldNotice
        metadata={{
          requirementReplacementWithheld: {
            ...withheld,
            reason: "degraded-synthesis",
            reviewedCount: 0,
          },
        }}
      />,
    );
    expect(screen.getByTestId("requirement-replacement-withheld")).toHaveTextContent(
      /degraded result never overwrites a successful one/,
    );
  });

  it("offers no actions for a refusal that kept nothing (#780), or without the analysis", () => {
    renderActionable(withheld);
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
    render(
      <RequirementReplacementWithheldNotice
        metadata={{ requirementReplacementWithheld: { ...withheld, proposalStored: true } }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Review changes" })).not.toBeInTheDocument();
  });

  it("Review changes shows a readable comparison by title, without ids", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    renderActionable();
    const review = screen.getByRole("button", { name: "Review changes" });
    expect(review).toHaveAttribute("aria-expanded", "false");
    expect(api.getWithheldReplacement).not.toHaveBeenCalled();
    fireEvent.click(review);
    expect(screen.getByRole("button", { name: "Hide changes" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const panel = await screen.findByRole("region", { name: "Changes the new result would make" });
    expect(api.getWithheldReplacement).toHaveBeenCalledWith("p-1", "an-1");
    await within(panel).findByText(/Applying would add 1 requirement, change 2, remove 1\./);
    expect(panel).toHaveTextContent(/1 reviewed requirement the new result leaves out is kept/);
    expect(panel).toHaveTextContent(/3 are unchanged/);

    const added = within(panel).getByRole("region", { name: "New requirements" });
    expect(added).toHaveTextContent("Export feeds as OPML");
    expect(added).toHaveTextContent("Priority high");
    expect(added).toHaveTextContent("An OPML file downloads.");

    const changed = within(panel).getByRole("region", { name: "Changed requirements" });
    expect(changed).toHaveTextContent("Feed listing");
    expect(changed).toHaveTextContent("Approved");
    expect(changed).toHaveTextContent(/Its review work is kept/);
    expect(changed).toHaveTextContent("Description");
    expect(changed).toHaveTextContent(/Current\s*Lists feeds\./);
    expect(changed).toHaveTextContent(/New\s*Lists feeds, 100 per page\./);
    expect(changed).toHaveTextContent("Acceptance criteria");
    expect(changed).toHaveTextContent("None");
    expect(changed).toHaveTextContent(/Login\s*Not reviewed/);
    expect(changed).toHaveTextContent("Replaced with the new version.");

    const removed = within(panel).getByRole("region", { name: "Not in the new result" });
    expect(removed).toHaveTextContent(/Old import.*Will be removed \(no review work\)/);
    expect(removed).toHaveTextContent(
      /Dark mode.*Has review work.*Kept, because it has review work/,
    );

    const skipped = within(panel).getByRole("region", { name: "Not restored" });
    expect(skipped).toHaveTextContent(/Telemetry.*Applying will not bring it back/);
    expect(panel).not.toHaveTextContent(/an-1|p-1/);
  });

  it("Apply changes confirms first, naming the reviewed requirements it rewords, then applies", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    api.applyWithheldReplacement.mockResolvedValue({
      added: 1,
      replaced: 1,
      updated: 1,
      deleted: 1,
      kept: 1,
    });
    const { invalidate } = renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Apply the new requirements?" });
    expect(dialog).toHaveTextContent(/Nothing with review work is deleted/);
    expect(dialog).toHaveTextContent(/1 reviewed requirement gets the new wording/);
    expect(within(dialog).getByRole("listitem")).toHaveTextContent("Feed listing (Approved)");
    expect(api.applyWithheldReplacement).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));
    await waitFor(() =>
      expect(api.applyWithheldReplacement).toHaveBeenCalledWith("p-1", "an-1", withheld.at, "fp-1"),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Applied the new requirements: 1 added, 2 changed, 1 removed, 1 reviewed kept",
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("Cancel in the confirmation applies nothing", async () => {
    api.getWithheldReplacement.mockResolvedValue({ ...DIFF, changed: [] });
    renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog).not.toHaveTextContent(/gets the new wording/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.applyWithheldReplacement).not.toHaveBeenCalled();
  });

  it("Dismiss is offered only once the comparison is open, and asks first", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    renderActionable();
    expect(screen.queryByRole("button", { name: "Dismiss changes" })).not.toBeInTheDocument();
    const dialog = await openDismissConfirmation();
    expect(dialog).toHaveTextContent(/cannot be brought back/);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(api.dismissWithheldReplacement).not.toHaveBeenCalled();
  });

  it("Dismiss changes keeps the current requirements and refreshes the analysis", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    api.dismissWithheldReplacement.mockResolvedValue({ discarded: 30 });
    const { invalidate } = renderActionable();
    const dialog = await openDismissConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss changes" }));
    await waitFor(() =>
      expect(api.dismissWithheldReplacement).toHaveBeenCalledWith("p-1", "an-1", withheld.at),
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Kept your current requirements. The new result was discarded.",
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    expect(api.applyWithheldReplacement).not.toHaveBeenCalled();
  });

  it("a refused answer (a newer re-synthesis) is shown and the analysis re-read", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    api.dismissWithheldReplacement.mockRejectedValue(new Error("A newer re-synthesis arrived"));
    const { invalidate } = renderActionable();
    const dialog = await openDismissConfirmation();
    fireEvent.click(within(dialog).getByRole("button", { name: "Dismiss changes" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("requirements changed since the review: says so, applies nothing and reloads the comparison", async () => {
    api.getWithheldReplacement
      .mockResolvedValueOnce(DIFF)
      .mockResolvedValue({ ...DIFF, fingerprint: "fp-2", changed: [] });
    api.applyWithheldReplacement.mockRejectedValue(
      new ApiError(
        409,
        "The requirements changed since you reviewed this comparison.",
        "CHANGED_SINCE_REVIEW",
      ),
    );
    renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply changes" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /requirements changed after you opened this comparison, so nothing was applied/,
    );
    await waitFor(() => expect(api.getWithheldReplacement).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Changed requirements" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    // The next Apply sends the refreshed comparison's fingerprint.
    api.applyWithheldReplacement.mockResolvedValue({
      added: 1,
      replaced: 0,
      updated: 0,
      deleted: 1,
      kept: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply changes" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Apply changes" }),
    );
    await waitFor(() =>
      expect(api.applyWithheldReplacement).toHaveBeenLastCalledWith(
        "p-1",
        "an-1",
        withheld.at,
        "fp-2",
      ),
    );
  });

  it("a newer re-synthesis replaced the reviewed one: says so, not that the requirements changed", async () => {
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    api.applyWithheldReplacement.mockRejectedValue(
      new ApiError(409, "A newer re-synthesis replaced the one you reviewed.", "STALE"),
    );
    api.dismissWithheldReplacement.mockRejectedValue(
      new ApiError(409, "A newer re-synthesis replaced the one you reviewed.", "STALE"),
    );
    const { invalidate } = renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Apply changes" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Apply changes" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      /A newer re-synthesis replaced the one you were reviewing, so nothing was changed/,
    );
    expect(alert).not.toHaveTextContent(/requirements changed after you opened/);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
    // Dismiss refused the same way says the same.
    fireEvent.click(screen.getByRole("button", { name: "Dismiss changes" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog", { name: "Dismiss the new result?" })).getByRole(
        "button",
        { name: "Dismiss changes" },
      ),
    );
    await waitFor(() => expect(api.dismissWithheldReplacement).toHaveBeenCalled());
    expect(await screen.findByRole("alert")).toHaveTextContent(/A newer re-synthesis replaced/);
  });

  it("a developer can review the changes but is told to ask someone who can edit the project", async () => {
    auth.role = "developer";
    auth.permissions = ["analysis.run", "analysis.read"];
    api.getWithheldReplacement.mockResolvedValue(DIFF);
    renderActionable();
    expect(screen.getByTestId("requirement-replacement-withheld")).not.toHaveTextContent(
      /apply it or keep/,
    );
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    const panel = await screen.findByRole("region", { name: "Changes the new result would make" });
    await within(panel).findByText(
      /Ask someone who can edit this project \(a coordinator or admin\) to apply or dismiss these changes\./,
    );
    expect(within(panel).getByRole("region", { name: "Changed requirements" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss changes" })).not.toBeInTheDocument();
  });

  it("says when the comparison cannot be loaded", async () => {
    api.getWithheldReplacement.mockRejectedValue(new Error("gone"));
    renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(await screen.findByText(/comparison could not be loaded/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply changes" })).not.toBeInTheDocument();
  });

  it("says when the new result matches the current requirements", async () => {
    api.getWithheldReplacement.mockResolvedValue({
      ...DIFF,
      added: [],
      changed: [],
      removed: [],
      skipped: [],
      unchangedCount: 1,
    });
    renderActionable();
    fireEvent.click(screen.getByRole("button", { name: "Review changes" }));
    expect(
      await screen.findByText("The new result matches your current requirements."),
    ).toBeInTheDocument();
  });
});

describe("summarizeWithheldReplacement (#780)", () => {
  it("counts in words, with plurals", () => {
    expect(
      summarizeWithheldReplacement({
        ...DIFF,
        added: [DIFF.added[0]!, DIFF.added[0]!],
        removed: [DIFF.removed[1]!, DIFF.removed[1]!],
        unchangedCount: 1,
      }),
    ).toBe(
      "Applying would add 2 requirements, change 2, remove 0. 2 reviewed requirements the new result leaves out are kept. 1 is unchanged.",
    );
    expect(summarizeWithheldReplacement({ ...DIFF, removed: [], unchangedCount: 0 })).toBe(
      "Applying would add 1 requirement, change 2, remove 0.",
    );
  });
});
