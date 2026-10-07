/**
 * #776 — batch drafts can be edited before publish, and one draft can become a
 * draft pull request (dry run first, then an explicit confirm).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "proj_1" })),
    useSearchParams: vi.fn(() => new URLSearchParams()),
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
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
    editDraft: vi.fn(),
    draftPullRequest: vi.fn(),
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
import { changedFields, parseDraftLabels } from "@/components/publishing/draft-edit-dialog";

const mock = (fn: unknown) => fn as unknown as ReturnType<typeof vi.fn>;
const listDrafts = mock(publishingApi.listDrafts);
const editDraft = mock(publishingApi.editDraft);
const draftPullRequest = mock(publishingApi.draftPullRequest);

const DRAFT = {
  id: "draft_1",
  title: "[Feature] Migrations race",
  body: "_No acceptance criteria were derived._",
  labels: JSON.stringify(["feature", "finding:cmurn1"]),
  draftType: "feature",
  storyPoints: 3,
  status: "approved",
  metadata: null,
};

const PLAN = {
  dryRun: true,
  target: { owner: "openzigs", repo: "flux-v2" },
  branch: "metis/draft-draft_1",
  path: ".metis/drafts/draft_1.md",
  title: DRAFT.title,
  actions: [
    { kind: "branch.create", summary: "create metis/draft-draft_1 from the default branch" },
    { kind: "file.commit", summary: "commit .metis/drafts/draft_1.md" },
    { kind: "pullRequest.createDraft", summary: "open a draft pull request into openzigs/flux-v2" },
  ],
  credentialCheck: "resolved",
  pullRequest: null,
  upstreamCheck: {
    forkNetworkChecked: false,
    note: "Checked against this project's repository connections only.",
  },
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
  listDrafts.mockResolvedValue([DRAFT]);
  mock(publishingApi.listBatches).mockResolvedValue([]);
});

describe("changedFields / parseDraftLabels", () => {
  it("returns only what changed, and null when nothing did", () => {
    const d = { title: "T", body: "B", labels: '["a","b"]' };
    expect(changedFields(d, { title: "T", body: "B", labels: "a, b" })).toBeNull();
    expect(changedFields(d, { title: " T2 ", body: "B", labels: "a, b" })).toEqual({ title: "T2" });
    expect(changedFields(d, { title: "T", body: "B2", labels: "a" })).toEqual({
      body: "B2",
      labels: ["a"],
    });
  });

  it("reads malformed label JSON as no labels", () => {
    expect(parseDraftLabels("not json")).toEqual([]);
    expect(parseDraftLabels('{"a":1}')).toEqual([]);
  });
});

describe("Edit draft (#776)", () => {
  it("edits the title, body and labels and sends only the changes", async () => {
    editDraft.mockResolvedValue({ ...DRAFT, status: "draft" });
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-draft_1"));
    expect(await screen.findByText(/returns it to draft for re-approval/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Title"), {
      target: { value: "[metis-706 re-run] Lock migrations" },
    });
    fireEvent.change(screen.getByLabelText("Body (Markdown)"), {
      target: { value: "## Acceptance criteria\n- [ ] a lock is taken" },
    });
    fireEvent.change(screen.getByLabelText("Labels (comma-separated)"), {
      target: { value: "feature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(editDraft).toHaveBeenCalled());
    expect(editDraft).toHaveBeenCalledWith("proj_1", "draft_1", {
      title: "[metis-706 re-run] Lock migrations",
      body: "## Acceptance criteria\n- [ ] a lock is taken",
      labels: ["feature"],
    });
    await waitFor(() => expect(screen.queryByText("Edit draft")).not.toBeInTheDocument());
  });

  it("keeps Save disabled until something changes, and for an empty title", async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-draft_1"));
    const save = await screen.findByRole("button", { name: "Save draft" });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "  " } });
    expect(save).toBeDisabled();
  });

  it("shows the server's refusal inside the dialog", async () => {
    const { ApiError } = await import("@/lib/api-client");
    editDraft.mockRejectedValue(
      new ApiError(
        409,
        "another draft in this project already has that title",
        "DRAFT_TITLE_TAKEN",
      ),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId("edit-draft_1"));
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "Dup" } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      /already has that title/,
    );
  });

  it("offers no Edit for a published draft", async () => {
    listDrafts.mockResolvedValue([{ ...DRAFT, status: "published" }]);
    renderPage();
    await screen.findByText(DRAFT.title);
    expect(screen.queryByTestId("edit-draft_1")).not.toBeInTheDocument();
  });
});

describe("Draft pull request (#776)", () => {
  it("plans first (dry run, no target field) and opens only on confirm", async () => {
    draftPullRequest.mockResolvedValueOnce(PLAN).mockResolvedValueOnce({
      ...PLAN,
      dryRun: false,
      pullRequest: {
        number: 7,
        htmlUrl: "https://github.com/openzigs/flux-v2/pull/7",
        reused: false,
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId("draft-pr-draft_1"));
    const open = await screen.findByRole("button", { name: "Open draft PR" });
    expect(open).toBeDisabled();
    expect(within(screen.getByRole("dialog")).queryByLabelText(/owner|repo/i)).toBeNull();

    fireEvent.change(within(screen.getByRole("dialog")).getByLabelText("Vault secret ref"), {
      target: { value: "${vault:github-flux-v2-sandbox}" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Plan (dry run)" }));
    const plan = await screen.findByTestId("draft-pr-plan");
    expect(plan).toHaveTextContent("openzigs/flux-v2");
    expect(plan).toHaveTextContent("nothing was written");
    // A dry run says the fork network was not checked (PR #850 review).
    expect(screen.getByTestId("draft-pr-upstream-check")).toHaveTextContent(
      "repository connections only",
    );
    expect(draftPullRequest).toHaveBeenLastCalledWith("proj_1", "draft_1", {
      secretRef: "${vault:github-flux-v2-sandbox}",
      dryRun: true,
    });

    fireEvent.click(screen.getByRole("button", { name: "Open draft PR" }));
    await waitFor(() =>
      expect(draftPullRequest).toHaveBeenLastCalledWith("proj_1", "draft_1", {
        secretRef: "${vault:github-flux-v2-sandbox}",
        dryRun: false,
      }),
    );
    expect(await screen.findByRole("link", { name: "#7" })).toHaveAttribute(
      "href",
      "https://github.com/openzigs/flux-v2/pull/7",
    );
  });

  it("does not offer the live run when the credential did not resolve", async () => {
    draftPullRequest.mockResolvedValueOnce({ ...PLAN, credentialCheck: "missing" });
    renderPage();
    fireEvent.click(await screen.findByTestId("draft-pr-draft_1"));
    fireEvent.click(await screen.findByRole("button", { name: "Plan (dry run)" }));
    expect(await screen.findByText(/a live run needs one/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open draft PR" })).toBeDisabled();
  });

  it("shows the server's refusal (e.g. no saved target)", async () => {
    const { ApiError } = await import("@/lib/api-client");
    draftPullRequest.mockRejectedValue(
      new ApiError(409, "save a GitHub publish target first", "PUBLISH_TARGET_NOT_CONFIGURED"),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId("draft-pr-draft_1"));
    fireEvent.click(await screen.findByRole("button", { name: "Plan (dry run)" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent(
      /publish target/,
    );
  });
});
