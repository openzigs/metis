/**
 * #1180 — the draft pull request dialog offers the Publish page's
 * cross-project confirm: a live run refused with `REPO_CROSS_PROJECT` opens it,
 * and confirming retries the same run with `confirmCrossProject: true`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import { ApiError } from "@/lib/api-client";

const draftPullRequest = vi.fn();
vi.mock("@/lib/publishing-api", () => ({
  publishingApi: { draftPullRequest: (...a: unknown[]) => draftPullRequest(...a) },
}));

import { DraftPullRequestDialog } from "@/components/publishing/draft-pull-request-dialog";

const SECRET = "${vault:gh}";
const PLAN = {
  dryRun: true,
  target: { owner: "openzigs", repo: "flux-v2" },
  branch: "metis/draft-d1",
  path: ".metis/drafts/d1.md",
  title: "Spec",
  actions: [{ kind: "branch.create", summary: "create metis/draft-d1" }],
  credentialCheck: "resolved",
  pullRequest: null,
  upstreamCheck: null,
};
const OPENED = {
  ...PLAN,
  dryRun: false,
  pullRequest: { number: 7, htmlUrl: "https://github.com/openzigs/flux-v2/pull/7", reused: false },
};

function refusal(projects: string[]) {
  return new ApiError(409, "openzigs/flux-v2 is already connected", "REPO_CROSS_PROJECT", {
    repo: "openzigs/flux-v2",
    projects,
  });
}

async function planThenOpen() {
  render(
    <DraftPullRequestDialog
      projectId="proj_1"
      draft={{ id: "d1", title: "Spec" }}
      onOpenChange={() => {}}
    />,
    { wrapper: makeWrapper({ withAuth: false }) },
  );
  fireEvent.change(screen.getByLabelText("Vault secret ref"), { target: { value: SECRET } });
  fireEvent.click(screen.getByRole("button", { name: "Plan (dry run)" }));
  await screen.findByTestId("draft-pr-plan");
  fireEvent.click(screen.getByRole("button", { name: "Open draft PR" }));
}

beforeEach(() => {
  draftPullRequest.mockReset();
});

describe("<DraftPullRequestDialog /> — cross-project confirm (#1180)", () => {
  it("asks before opening a PR into a repo another project connects, then retries with the confirm", async () => {
    draftPullRequest
      .mockResolvedValueOnce(PLAN)
      .mockRejectedValueOnce(refusal(["Flux sandbox"]))
      .mockResolvedValueOnce(OPENED);
    await planThenOpen();

    const text = await screen.findByTestId("cross-project-confirm-text");
    expect(text).toHaveTextContent(
      "openzigs/flux-v2 is already connected to the project “Flux sandbox”",
    );
    expect(text).toHaveTextContent("A draft pull request opened from this project");
    expect(draftPullRequest.mock.calls[1][2]).toEqual({ secretRef: SECRET, dryRun: false });

    fireEvent.click(screen.getByTestId("cross-project-confirm-button"));
    await screen.findByText("#7");
    expect(draftPullRequest.mock.calls[2][2]).toEqual({
      secretRef: SECRET,
      dryRun: false,
      confirmCrossProject: true,
    });
    await waitFor(() =>
      expect(screen.queryByTestId("cross-project-confirm")).not.toBeInTheDocument(),
    );
  });

  it("says 'another project' when the server names none, and Cancel opens nothing", async () => {
    draftPullRequest.mockResolvedValueOnce(PLAN).mockRejectedValueOnce(refusal([]));
    await planThenOpen();

    const confirm = await screen.findByTestId("cross-project-confirm");
    expect(screen.getByTestId("cross-project-confirm-text")).toHaveTextContent(
      "is already connected to another project",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByTestId("cross-project-confirm")).not.toBeInTheDocument(),
    );
    expect(draftPullRequest).toHaveBeenCalledTimes(2);
  });

  it("any other failure opens no confirm", async () => {
    draftPullRequest
      .mockResolvedValueOnce(PLAN)
      .mockRejectedValueOnce(new ApiError(502, "GitHub said no", "GITHUB_REQUEST_FAILED"));
    await planThenOpen();
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub said no");
    expect(screen.queryByTestId("cross-project-confirm")).not.toBeInTheDocument();
  });
});
