/**
 * Publishing page — #733. Every publish target used to default to the repo
 * connector's own repository (an analysed project's upstream), the batch form
 * ignored the target the drafts were generated for, and nothing persisted.
 *
 *  - The batch form inherits the selected drafts' target, as a VALUE.
 *  - "Save as project target" persists the target through publish-destination.
 *  - A target that is the analysed repository is called out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "proj_1" })),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/"),
  };
});

vi.mock("@/lib/socket-client", () => ({ useSocket: vi.fn(() => null) }));

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn().mockResolvedValue({ items: [] }) },
}));

vi.mock("@/lib/publishing-api", () => ({
  publishingApi: {
    listDrafts: vi.fn(),
    listBatches: vi.fn(),
    generateDrafts: vi.fn(),
    approveDraft: vi.fn(),
    createBatch: vi.fn(),
    previewBatch: vi.fn(),
    cancelBatch: vi.fn(),
  },
  reviewGateApi: { get: vi.fn().mockResolvedValue({ requireApprovedReview: false }) },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { getPrimary: vi.fn() },
}));

vi.mock("@/lib/change-analysis-api", () => ({
  publishDestinationApi: { get: vi.fn(), update: vi.fn() },
}));

import { publishingApi } from "@/lib/publishing-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { publishDestinationApi } from "@/lib/change-analysis-api";
import PublishingPage from "@/app/(authed)/projects/[id]/publish/page";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const listDrafts = mock(publishingApi.listDrafts);
const listBatches = mock(publishingApi.listBatches);
const createBatch = mock(publishingApi.createBatch);
const getPrimary = mock(repoConnectorsApi.getPrimary);
const getDest = mock(publishDestinationApi.get);
const updateDest = mock(publishDestinationApi.update);

const meta = (owner: string, repo: string) =>
  JSON.stringify({ analysisId: "a1", targetOwner: owner, targetRepo: repo });

function draft(id: string, title: string, metadata: string | null) {
  return {
    id,
    title,
    body: "…",
    draftType: "feature",
    storyPoints: 3,
    status: "approved",
    metadata,
  };
}

function dest(
  githubOwner: string | null,
  githubRepo: string | null,
  publishDestination = "github",
) {
  return {
    publishDestination,
    jiraProjectKey: publishDestination === "github" ? null : "ACME",
    jiraConnectionId: publishDestination === "github" ? null : "jc_1",
    githubOwner,
    githubRepo,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <PublishingPage />
    </Wrapper>,
  );
}

async function select(title: string): Promise<void> {
  const box = await screen.findByRole("checkbox", { name: `Select draft: ${title}` });
  fireEvent.click(box);
}

beforeEach(() => {
  vi.clearAllMocks();
  listBatches.mockResolvedValue([]);
  listDrafts.mockResolvedValue([]);
  createBatch.mockResolvedValue({
    batch: { id: "batch_new_1", dryRunPlan: null },
    run: { status: "completed" },
  });
  getPrimary.mockResolvedValue({ ownerOrOrg: "miniflux", repoName: "v2", apiBaseUrl: null });
  getDest.mockResolvedValue(dest(null, null));
});

describe("batch form inherits the drafts' target (#733)", () => {
  it("shows the selected drafts' target as the batch value — not the connector's repo", async () => {
    listDrafts.mockResolvedValue([draft("d1", "One", meta("openzigs", "flux-v2"))]);
    renderPage();
    await select("One");
    expect(screen.getByLabelText("Owner")).toHaveValue("openzigs");
    expect(screen.getByLabelText("Repo")).toHaveValue("flux-v2");

    fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));
    await waitFor(() => expect(createBatch).toHaveBeenCalled());
    expect(createBatch.mock.calls[0][1]).toMatchObject({
      targetOwner: "openzigs",
      targetRepo: "flux-v2",
    });
  });

  it("falls back to the Generate form's target when the selected drafts disagree", async () => {
    listDrafts.mockResolvedValue([
      draft("d1", "One", meta("openzigs", "flux-v2")),
      draft("d2", "Two", meta("other", "repo")),
    ]);
    renderPage();
    await select("One");
    await select("Two");
    expect(screen.getByLabelText("Owner")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "me" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "sandbox" } });
    expect(screen.getByLabelText("Owner")).toHaveValue("me");
    expect(screen.getByLabelText("Repo")).toHaveValue("sandbox");
  });

  it("follows the Generate form's target for drafts that predate #733", async () => {
    getDest.mockResolvedValue(dest("openzigs", "flux-v2"));
    listDrafts.mockResolvedValue([draft("d1", "Legacy", null)]);
    renderPage();
    await select("Legacy");
    await waitFor(() => expect(screen.getByLabelText("Owner")).toHaveValue("openzigs"));
    expect(screen.getByLabelText("Repo")).toHaveValue("flux-v2");
  });

  it("keeps a value the user typed into the batch form", async () => {
    listDrafts.mockResolvedValue([draft("d1", "One", meta("openzigs", "flux-v2"))]);
    renderPage();
    await select("One");
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "elsewhere" } });
    fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));
    await waitFor(() => expect(createBatch).toHaveBeenCalled());
    expect(createBatch.mock.calls[0][1]).toMatchObject({
      targetOwner: "elsewhere",
      targetRepo: "flux-v2",
    });
  });

  it("warns when the batch target is the analysed repository", async () => {
    listDrafts.mockResolvedValue([draft("d1", "One", meta("miniflux", "v2"))]);
    renderPage();
    await select("One");
    expect(await screen.findByTestId("batch-target-upstream-warning")).toHaveTextContent(
      "miniflux/v2 is the repository this project analyses",
    );
  });
});

describe("saving the project's publish target (#733)", () => {
  it("persists the Generate form's target, keeping the destination's other settings", async () => {
    getDest.mockResolvedValue(dest(null, null, "both"));
    updateDest.mockResolvedValue(dest("openzigs", "flux-v2", "both"));
    renderPage();
    await screen.findByTestId("publish-target-unset");
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: " openzigs " } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "flux-v2" } });
    fireEvent.click(screen.getByTestId("publish-target-save"));
    await waitFor(() => expect(updateDest).toHaveBeenCalled());
    expect(updateDest).toHaveBeenCalledWith("proj_1", {
      publishDestination: "both",
      jiraProjectKey: "ACME",
      jiraConnectionId: "jc_1",
      githubOwner: "openzigs",
      githubRepo: "flux-v2",
    });
    await waitFor(() =>
      expect(screen.getByTestId("publish-target-save")).toHaveTextContent(
        "Saved as project target",
      ),
    );
    expect(screen.getByTestId("publish-target-save")).toBeDisabled();
    expect(screen.queryByTestId("publish-target-unset")).not.toBeInTheDocument();
  });

  it("disables Save until both owner and repo are filled", async () => {
    renderPage();
    await screen.findByTestId("publish-target-unset");
    expect(screen.getByTestId("publish-target-save")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "openzigs" } });
    expect(screen.getByTestId("publish-target-save")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "flux-v2" } });
    expect(screen.getByTestId("publish-target-save")).toBeEnabled();
  });

  it("surfaces a failed save", async () => {
    updateDest.mockRejectedValue(new Error("nope"));
    renderPage();
    await screen.findByTestId("publish-target-unset");
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "openzigs" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "flux-v2" } });
    fireEvent.click(screen.getByTestId("publish-target-save"));
    expect(await screen.findByTestId("publish-target-save-error")).toHaveTextContent(
      "Could not save the publish target.",
    );
  });

  it("warns when the Generate form's target is the analysed repository", async () => {
    renderPage();
    await screen.findByTestId("publish-target-unset");
    expect(screen.queryByTestId("publish-target-upstream-warning")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "miniflux" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "V2" } });
    expect(await screen.findByTestId("publish-target-upstream-warning")).toBeInTheDocument();
  });
});
