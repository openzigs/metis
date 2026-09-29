/**
 * Publishing page — issue #23: approving drafts did not select them. After
 * approving every draft the batch form still read "0 drafts selected" with
 * "Run dry-run" disabled and no hint that selection is a separate step.
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
  repoConnectorsApi: { getPrimary: vi.fn().mockResolvedValue(null) },
}));

import { publishingApi } from "@/lib/publishing-api";
import PublishingPage from "@/app/(authed)/projects/[id]/publish/page";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const listDrafts = mock(publishingApi.listDrafts);
const listBatches = mock(publishingApi.listBatches);
const approveDraft = mock(publishingApi.approveDraft);

const DRAFT = {
  id: "draft_1",
  title: "Add OAuth login",
  body: "…",
  draftType: "feature",
  storyPoints: 3,
  status: "draft",
  metadata: null,
};

function renderPage() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <PublishingPage />
    </Wrapper>,
  );
}

async function fillTarget(): Promise<void> {
  fireEvent.change(screen.getByLabelText("Owner"), { target: { value: "openzigs" } });
  fireEvent.change(screen.getByLabelText("Repo"), { target: { value: "example" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  listDrafts.mockResolvedValue([DRAFT]);
  listBatches.mockResolvedValue([]);
});

describe("approving a draft selects it for the batch (#23)", () => {
  it("selects the approved draft and enables the dry-run", async () => {
    approveDraft.mockImplementation(async () => {
      listDrafts.mockResolvedValue([{ ...DRAFT, status: "approved" }]);
      return { ...DRAFT, status: "approved" };
    });
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: `Select draft: ${DRAFT.title}` });
    await fillTarget();
    expect(checkbox).not.toBeChecked();
    expect(screen.getByRole("button", { name: "Run dry-run" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(checkbox).toBeChecked());
    expect(approveDraft).toHaveBeenCalledWith("proj_1", "draft_1");
    expect(screen.getByText("1 drafts selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Run dry-run" })).toBeEnabled();
  });

  it("does not select a draft whose approval failed", async () => {
    approveDraft.mockRejectedValue(new Error("blocked"));
    renderPage();
    const checkbox = await screen.findByRole("checkbox", { name: `Select draft: ${DRAFT.title}` });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approveDraft).toHaveBeenCalled());
    await screen.findByTestId("approve-error-draft_1");
    expect(checkbox).not.toBeChecked();
    expect(screen.getByText("0 drafts selected")).toBeInTheDocument();
  });

  it("tells the user that selection is a separate step while nothing is selected", async () => {
    renderPage();
    await screen.findByRole("checkbox", { name: `Select draft: ${DRAFT.title}` });
    expect(screen.getByTestId("publish-selection-hint")).toHaveTextContent(
      /tick the drafts to include/i,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: `Select draft: ${DRAFT.title}` }));
    expect(screen.queryByTestId("publish-selection-hint")).not.toBeInTheDocument();
  });
});
