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
  return {
    ...actual,
    projectsApi: { ...actual.projectsApi, update: vi.fn(), getPrReviewBudget: vi.fn() },
  };
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
const getBudget = projectsApi.getPrReviewBudget as unknown as ReturnType<typeof vi.fn>;

function budget(over: Record<string, unknown> = {}) {
  return {
    allowed: true,
    capCents: null,
    spentCents: 0,
    spentUsd: 0,
    monthBucket: "2026-10",
    resetAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

const githubRepo = { id: "r1", provider: "github", ownerOrOrg: "acme", repoName: "app" };

beforeEach(() => {
  update.mockReset();
  listRepos.mockReset();
  getBudget.mockReset();
  getBudget.mockResolvedValue(budget());
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
const limitInput = () => screen.getByLabelText(/monthly limit for automatic PR reviews/i);
const limitSave = () => screen.getByTestId("auto-review-prs-limit-save");

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

  it("says plainly that without a monthly limit there is no cap on the spend", () => {
    listRepos.mockReturnValue(new Promise(() => undefined));
    renderCard();
    expect(
      screen.getByText(/without a monthly limit there is no cap on this spend/i),
    ).toBeInTheDocument();
  });

  it("can be switched OFF while the repositories are still loading", () => {
    listRepos.mockReturnValue(new Promise(() => undefined));
    renderCard({ enabled: true });
    expect(toggle()).toBeEnabled();
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

  describe("monthly limit", () => {
    it("#1471 — says what to do when a limit is set and the model has no price", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue({
        ...budget({ capCents: 2500, spentCents: 0 }),
        modelPriced: false,
      });
      renderCard({ monthlyBudgetCents: 2500 });
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-unpriced")).toHaveTextContent(
          /no price.*MODEL_PRICES.*remove the limit/,
        ),
      );
    });

    it("#1471 — no unpriced notice for a priced model, or with no limit", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue({
        ...budget({ capCents: 2500, spentCents: 0 }),
        modelPriced: true,
      });
      const { unmount } = renderCard({ monthlyBudgetCents: 2500 });
      await waitFor(() => expect(screen.getByTestId("auto-review-prs-spend")).toBeInTheDocument());
      expect(screen.queryByTestId("auto-review-prs-unpriced")).toBeNull();
      unmount();
      getBudget.mockResolvedValue({
        ...budget({ capCents: null, spentCents: 0 }),
        modelPriced: false,
      });
      renderCard();
      await waitFor(() => expect(screen.getByTestId("auto-review-prs-spend")).toBeInTheDocument());
      expect(screen.queryByTestId("auto-review-prs-unpriced")).toBeNull();
    });

    it("#1478 — a cap of 0 is no limit: no unpriced notice, and the spend reads 'no limit'", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue({
        ...budget({ capCents: 0, spentCents: 40 }),
        modelPriced: false,
      });
      renderCard();
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-spend")).toHaveTextContent(
          "Spent on automatic PR reviews this month: $0.40 (no limit).",
        ),
      );
      expect(screen.queryByTestId("auto-review-prs-unpriced")).toBeNull();
    });

    it("shows the saved limit in dollars and this month's spend against it", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue(budget({ capCents: 2500, spentCents: 123 }));
      renderCard({ monthlyBudgetCents: 2500 });
      expect(limitInput()).toHaveValue(25);
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-spend")).toHaveTextContent(
          "Spent on automatic PR reviews this month: $1.23 of $25.00.",
        ),
      );
      expect(screen.queryByTestId("auto-review-prs-limit-reached")).toBeNull();
    });

    it("an empty field reads as no limit, with the spend still shown", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue(budget({ spentCents: 40 }));
      renderCard();
      expect(limitInput()).toHaveValue(null);
      expect(limitInput()).toHaveAttribute("placeholder", "No limit");
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-spend")).toHaveTextContent("$0.40 (no limit)."),
      );
    });

    it("saves a dollar amount as cents through PATCH /projects/:id", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      update.mockResolvedValue({ id: "p1", prReviewMonthlyBudgetCents: 1050 });
      renderCard();
      expect(limitSave()).toBeDisabled();
      fireEvent.change(limitInput(), { target: { value: "10.50" } });
      expect(limitSave()).toBeEnabled();
      fireEvent.click(limitSave());
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith("p1", { prReviewMonthlyBudgetCents: 1050 }),
      );
      await waitFor(() => expect(limitSave()).toBeDisabled());
    });

    it("clearing the field removes the limit (null)", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      update.mockResolvedValue({ id: "p1", prReviewMonthlyBudgetCents: null });
      renderCard({ monthlyBudgetCents: 500 });
      fireEvent.change(limitInput(), { target: { value: "" } });
      fireEvent.click(limitSave());
      await waitFor(() =>
        expect(update).toHaveBeenCalledWith("p1", { prReviewMonthlyBudgetCents: null }),
      );
    });

    it.each(["0", "-5", "0.001", "100000.01"])(
      "refuses %s without calling the server",
      async (value) => {
        listRepos.mockResolvedValue([githubRepo]);
        renderCard();
        fireEvent.change(limitInput(), { target: { value } });
        fireEvent.click(limitSave());
        await waitFor(() =>
          expect(screen.getByTestId("auto-review-prs-limit-error")).toBeInTheDocument(),
        );
        expect(update).not.toHaveBeenCalled();
      },
    );

    it("shows the server's refusal", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      update.mockRejectedValue(new ApiError(400, "Invalid project payload", "VALIDATION_ERROR"));
      renderCard();
      fireEvent.change(limitInput(), { target: { value: "5" } });
      fireEvent.click(limitSave());
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-limit-error")).toHaveTextContent(
          /invalid project payload/i,
        ),
      );
    });

    it("says when this month's limit is reached and reviews have stopped", async () => {
      listRepos.mockResolvedValue([githubRepo]);
      getBudget.mockResolvedValue(budget({ allowed: false, capCents: 100, spentCents: 150 }));
      renderCard({ enabled: true, monthlyBudgetCents: 100 });
      await waitFor(() =>
        expect(screen.getByTestId("auto-review-prs-limit-reached")).toHaveTextContent(
          /limit is reached, so new pull requests are not being reviewed/i,
        ),
      );
    });

    it("is read-only for a user without project.update", () => {
      listRepos.mockReturnValue(new Promise(() => undefined));
      renderCard({ canEdit: false, monthlyBudgetCents: 500 });
      expect(limitInput()).toBeDisabled();
      expect(limitSave()).toBeDisabled();
    });
  });
});
