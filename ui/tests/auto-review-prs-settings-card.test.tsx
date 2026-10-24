/**
 * #1169 — the project-settings toggle for automatic PR review.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { AutoReviewPrsSettingsCard } from "@/components/projects/auto-review-prs-settings-card";
import { makeWrapper } from "./test-utils";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, update: vi.fn() } };
});
vi.mock("@/lib/connectors-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/connectors-api")>("@/lib/connectors-api");
  return { ...actual, repoConnectorsApi: { ...actual.repoConnectorsApi, list: vi.fn() } };
});

import { projectsApi } from "@/lib/projects-api";
import { repoConnectorsApi } from "@/lib/connectors-api";

const update = projectsApi.update as unknown as ReturnType<typeof vi.fn>;
const listRepos = repoConnectorsApi.list as unknown as ReturnType<typeof vi.fn>;

const githubRepo = { id: "r1", provider: "github", ownerOrOrg: "acme", repoName: "app" };

beforeEach(() => {
  update.mockReset();
  listRepos.mockReset();
});

function renderCard(props: Partial<React.ComponentProps<typeof AutoReviewPrsSettingsCard>> = {}) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <AutoReviewPrsSettingsCard projectId="p1" enabled={false} canEdit {...props} />
    </Wrapper>,
  );
}

const toggle = () => screen.getByRole("checkbox", { name: /review pull requests automatically/i });

describe("AutoReviewPrsSettingsCard", () => {
  it("says what it does and that it spends model budget on every PR", async () => {
    listRepos.mockResolvedValue([githubRepo]);
    renderCard();
    expect(screen.getByText(/every pull request/i)).toBeInTheDocument();
    expect(screen.getByText(/model budget/i)).toBeInTheDocument();
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).not.toBeChecked();
  });

  it("is disabled with a reason while no GitHub repository is connected", async () => {
    listRepos.mockResolvedValue([{ ...githubRepo, provider: "local" }]);
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("auto-review-prs-reason")).toHaveTextContent(
        /connect a GitHub repository/i,
      ),
    );
    expect(toggle()).toBeDisabled();
    expect(screen.getByRole("link", { name: /connections/i })).toHaveAttribute(
      "href",
      "/projects/p1/connections",
    );
  });

  it("counts a GitHub Enterprise repository as connected", async () => {
    listRepos.mockResolvedValue([{ ...githubRepo, provider: "github_enterprise" }]);
    renderCard();
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(screen.queryByTestId("auto-review-prs-reason")).toBeNull();
  });

  it("is disabled while the repositories are still loading", () => {
    listRepos.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect(toggle()).toBeDisabled();
  });

  it("stays switchable OFF when it is on but the repository has gone", async () => {
    listRepos.mockResolvedValue([]);
    update.mockResolvedValue({ id: "p1", autoReviewPrs: false });
    renderCard({ enabled: true });
    await waitFor(() => expect(toggle()).toBeEnabled());
    expect(toggle()).toBeChecked();
    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalledWith("p1", { autoReviewPrs: false }));
  });

  it("is disabled with a reason for a user without project.update", async () => {
    listRepos.mockResolvedValue([githubRepo]);
    renderCard({ canEdit: false });
    await waitFor(() =>
      expect(screen.getByTestId("auto-review-prs-reason")).toHaveTextContent(/permission/i),
    );
    expect(toggle()).toBeDisabled();
  });

  it("turns it on through PATCH /projects/:id and shows the on state", async () => {
    listRepos.mockResolvedValue([githubRepo]);
    update.mockResolvedValue({ id: "p1", autoReviewPrs: true });
    renderCard();
    await waitFor(() => expect(toggle()).toBeEnabled());
    fireEvent.click(toggle());
    await waitFor(() => expect(update).toHaveBeenCalledWith("p1", { autoReviewPrs: true }));
    await waitFor(() => expect(toggle()).toBeChecked());
  });

  it("shows the server's error and reverts when the save fails", async () => {
    listRepos.mockResolvedValue([githubRepo]);
    update.mockRejectedValue(
      new ApiError(403, "Only the project owner or admin can mutate", "FORBIDDEN"),
    );
    renderCard();
    await waitFor(() => expect(toggle()).toBeEnabled());
    fireEvent.click(toggle());
    await waitFor(() =>
      expect(screen.getByTestId("auto-review-prs-error")).toHaveTextContent(/project owner/i),
    );
    expect(toggle()).not.toBeChecked();
  });

  it("disables the toggle with a reason when the repositories cannot be read", async () => {
    listRepos.mockRejectedValue(new Error("boom"));
    renderCard();
    await waitFor(() =>
      expect(screen.getByTestId("auto-review-prs-reason")).toHaveTextContent(/could not check/i),
    );
    expect(toggle()).toBeDisabled();
  });
});
