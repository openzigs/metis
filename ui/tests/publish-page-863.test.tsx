/**
 * Publishing page — #863, found in #706 walkthrough run 3:
 *  1. a published draft stayed in the selection, so every later batch failed
 *     `400 DRAFT_INELIGIBLE` until a reload;
 *  2. a settled batch could be archived through the API only;
 *  3. a 266-issue import became 267 drafts in one click, with no selection step.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "proj_1" })),
    useSearchParams: vi.fn(() => search.params),
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
    listDraftCandidates: vi.fn(),
    generateDrafts: vi.fn(),
    approveDraft: vi.fn(),
    createBatch: vi.fn(),
    previewBatch: vi.fn(),
    cancelBatch: vi.fn(),
    archiveBatch: vi.fn(),
  },
  reviewGateApi: { get: vi.fn().mockResolvedValue({ requireApprovedReview: false }) },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { getPrimary: vi.fn().mockResolvedValue(null) },
}));

import { publishingApi } from "@/lib/publishing-api";
import PublishingPage from "@/app/(authed)/projects/[id]/publish/page";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const api = {
  listDrafts: mock(publishingApi.listDrafts),
  listBatches: mock(publishingApi.listBatches),
  listDraftCandidates: mock(publishingApi.listDraftCandidates),
  generateDrafts: mock(publishingApi.generateDrafts),
  createBatch: mock(publishingApi.createBatch),
  archiveBatch: mock(publishingApi.archiveBatch),
};

function draft(id: string, status: string) {
  return {
    id,
    title: `Draft ${id}`,
    body: "…",
    draftType: "feature",
    storyPoints: 3,
    status,
    metadata: null,
  };
}

const BATCH = {
  id: "batch_completed_01",
  projectId: "proj_1",
  status: "completed",
  archived: false,
  dryRun: false,
  targetOwner: "openzigs",
  targetRepo: "example",
  publishedCount: 2,
  failedCount: 0,
  dedupSkipped: 0,
  startedAt: "2026-10-01T10:00:00.000Z",
  dryRunPlan: null,
};

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <PublishingPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  search.params = new URLSearchParams();
  api.listBatches.mockResolvedValue([]);
  api.listDraftCandidates.mockResolvedValue({
    analysisId: "analysis_1",
    source: "analysis",
    selectionRequired: false,
    requirements: [],
  });
});

describe("a published draft leaves the batch selection (#863)", () => {
  it("does not send a published draft in the next batch", async () => {
    api.listDrafts.mockResolvedValue([draft("draft_a", "approved")]);
    api.createBatch.mockImplementation(async () => {
      // The first batch published draft_a; a new draft has arrived since.
      api.listDrafts.mockResolvedValue([draft("draft_a", "published"), draft("draft_c", "draft")]);
      return { batch: { id: "batch_0000001", dryRunPlan: null }, run: { status: "completed" } };
    });
    renderPage();
    fireEvent.click(await screen.findByRole("checkbox", { name: "Select draft: Draft draft_a" }));
    fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "openzigs" } });
    fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "example" } });
    fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));

    const c = await screen.findByRole("checkbox", { name: "Select draft: Draft draft_c" });
    const a = screen.getByRole("checkbox", { name: "Select draft: Draft draft_a" });
    expect(a).toBeDisabled();
    expect(a).not.toBeChecked();
    expect(screen.getByText("0 drafts selected")).toBeInTheDocument();

    fireEvent.click(c);
    expect(screen.getByText("1 drafts selected")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run dry-run" }));
    await waitFor(() => expect(api.createBatch).toHaveBeenCalledTimes(2));
    expect(api.createBatch.mock.calls[1]![1]).toMatchObject({ draftIds: ["draft_c"] });
  });
});

describe("archiving a settled batch from the UI (#863)", () => {
  it("archives with a reason, closing nothing unless asked", async () => {
    api.listDrafts.mockResolvedValue([]);
    api.listBatches.mockResolvedValue([BATCH]);
    api.archiveBatch.mockResolvedValue({ ...BATCH, archived: true });
    renderPage();
    fireEvent.click(await screen.findByTestId(`archive-batch-${BATCH.id}`));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Archive batch" });
    expect(confirm).toBeDisabled();
    expect(within(dialog).getByRole("checkbox")).not.toBeChecked();

    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "walkthrough clean-up" },
    });
    fireEvent.click(confirm);
    await waitFor(() =>
      expect(api.archiveBatch).toHaveBeenCalledWith("proj_1", BATCH.id, {
        reason: "walkthrough clean-up",
        closeIssues: false,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes the batch's issues only when the box is ticked", async () => {
    api.listDrafts.mockResolvedValue([]);
    api.listBatches.mockResolvedValue([BATCH]);
    api.archiveBatch.mockResolvedValue({ ...BATCH, archived: true });
    renderPage();
    fireEvent.click(await screen.findByTestId(`archive-batch-${BATCH.id}`));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Reason"), { target: { value: "wrong repo" } });
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive batch" }));
    await waitFor(() =>
      expect(api.archiveBatch).toHaveBeenCalledWith("proj_1", BATCH.id, {
        reason: "wrong repo",
        closeIssues: true,
      }),
    );
  });

  it("offers no close for a dry run, which created nothing", async () => {
    api.listDrafts.mockResolvedValue([]);
    api.listBatches.mockResolvedValue([{ ...BATCH, dryRun: true, publishedCount: 0 }]);
    renderPage();
    fireEvent.click(await screen.findByTestId(`archive-batch-${BATCH.id}`));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
  });
});

describe("choosing which imported requirements to draft (#863)", () => {
  const requirements = Array.from({ length: 30 }, (_, i) => ({
    id: `imp_req_${i + 1}`,
    title: `Upstream issue ${i + 1}`,
    type: "feature",
    priority: "medium",
    externalUrl: null,
  }));

  it("requires a selection and sends only the chosen requirements", async () => {
    search.params = new URLSearchParams({ analysisId: "analysis_import_1" });
    api.listDrafts.mockResolvedValue([]);
    api.listDraftCandidates.mockResolvedValue({
      analysisId: "analysis_import_1",
      source: "import",
      selectionRequired: true,
      requirements,
    });
    api.generateDrafts.mockResolvedValue({
      summary: { total: 3, epics: 1, features: 2, upserted: 3, refreshed: 0 },
    });
    renderPage();
    await screen.findByTestId("draft-requirement-picker");
    expect(api.listDraftCandidates).toHaveBeenCalledWith("proj_1", "analysis_import_1");
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "openzigs" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "example" } });
    const generate = screen.getByRole("button", { name: "Generate" });
    expect(generate).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: "Draft requirement: Upstream issue 2" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Draft requirement: Upstream issue 5" }));
    expect(screen.getByTestId("draft-requirement-picker-count")).toHaveTextContent("2 selected");
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await waitFor(() =>
      expect(api.generateDrafts).toHaveBeenCalledWith("proj_1", {
        analysisId: "analysis_import_1",
        targetOwner: "openzigs",
        targetRepo: "example",
        requirementIds: ["imp_req_2", "imp_req_5"],
      }),
    );
  });

  it("select all and clear drive the selection", async () => {
    search.params = new URLSearchParams({ analysisId: "analysis_import_1" });
    api.listDrafts.mockResolvedValue([]);
    api.listDraftCandidates.mockResolvedValue({
      analysisId: "analysis_import_1",
      source: "import",
      selectionRequired: true,
      requirements,
    });
    renderPage();
    await screen.findByTestId("draft-requirement-picker");
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(screen.getByTestId("draft-requirement-picker-count")).toHaveTextContent("30 selected");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByTestId("draft-requirement-picker-count")).toHaveTextContent("0 selected");
  });

  it("shows no selection step for an ordinary analysis", async () => {
    search.params = new URLSearchParams({ analysisId: "analysis_1" });
    api.listDrafts.mockResolvedValue([]);
    renderPage();
    await waitFor(() => expect(api.listDraftCandidates).toHaveBeenCalled());
    expect(screen.queryByTestId("draft-requirement-picker")).toBeNull();
  });
});
