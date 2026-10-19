/**
 * #1136 — the publish page itself shows each created issue's number and link,
 * on the batch and on the draft, and Watch on a finished batch says it
 * finished instead of "Waiting for events…". The components are unit-tested in
 * `publishing-published-issues.test.tsx`; this pins the page's wiring of them
 * (adversarial panel, `test-falsifiability`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

const ISSUE_URL = "https://github.com/openzigs/flux-v2/issues/12";

function batch(status: string) {
  return {
    id: "batch_completed_01",
    projectId: "proj_1",
    status,
    archived: false,
    dryRun: false,
    targetOwner: "openzigs",
    targetRepo: "flux-v2",
    publishedCount: 1,
    failedCount: 0,
    dedupSkipped: 0,
    startedAt: "2026-10-13T18:19:00.000Z",
    dryRunPlan: null,
    publishedIssues: [
      {
        id: "pi_1",
        batchId: "batch_completed_01",
        draftId: "draft_a",
        issueNumber: 12,
        issueId: "I_kw12",
        htmlUrl: ISSUE_URL,
        status: "created",
        destination: "github",
        parentIssueNumber: null,
        dedupHash: null,
        bodyHash: null,
        errorMessage: null,
        publishedAt: "2026-10-13T18:19:34.000Z",
      },
    ],
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

beforeEach(() => {
  vi.clearAllMocks();
  mock(publishingApi.listDrafts).mockResolvedValue([
    {
      id: "draft_a",
      title: "Draft A",
      body: "…",
      draftType: "feature",
      storyPoints: 3,
      status: "published",
      metadata: null,
    },
  ]);
  mock(publishingApi.listDraftCandidates).mockResolvedValue({
    analysisId: "analysis_1",
    source: "analysis",
    selectionRequired: false,
    requirements: [],
  });
});

describe("publish page — created issues are shown (#1136)", () => {
  it("links the created issue on the batch row and on its draft", async () => {
    mock(publishingApi.listBatches).mockResolvedValue([batch("completed")]);
    renderPage();
    const published = await screen.findByTestId("draft-published-issue");
    expect(published.textContent).toContain("Published as");
    const links = await screen.findAllByRole("link", { name: "openzigs/flux-v2#12" });
    // At least one on the draft and one in the batch's Published cell.
    expect(links.length).toBeGreaterThanOrEqual(2);
    for (const l of links) expect(l.getAttribute("href")).toBe(ISSUE_URL);
    expect((await screen.findAllByTestId("batch-published-issues")).length).toBeGreaterThan(0);
  });

  it("Watch on a finished batch says it finished instead of waiting", async () => {
    mock(publishingApi.listBatches).mockResolvedValue([batch("completed")]);
    renderPage();
    const [watch] = await screen.findAllByRole("button", { name: "Watch" });
    fireEvent.click(watch!);
    const log = await screen.findByTestId("publish-log");
    expect(log.textContent).toContain("This batch has finished");
    expect(log.textContent).not.toContain("Waiting for events");
  });

  it("Watch on a running batch still waits for events", async () => {
    mock(publishingApi.listBatches).mockResolvedValue([batch("running")]);
    renderPage();
    const [watch] = await screen.findAllByRole("button", { name: "Watch" });
    fireEvent.click(watch!);
    const log = await screen.findByTestId("publish-log");
    expect(log.textContent).toContain("Waiting for events");
  });
});
