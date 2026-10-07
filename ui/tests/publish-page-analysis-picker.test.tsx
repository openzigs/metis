/**
 * Publishing page — analysis source picker (usability quick win).
 *
 * Replaces the free-text "Analysis ID" input with a dropdown of the project's
 * analyses (via the existing analysisApi.listForProject client). Selecting an
 * analysis drives draft generation with that id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
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

vi.mock("@/lib/socket-client", () => ({
  useSocket: vi.fn(() => null),
}));

vi.mock("@/lib/analysis-api", () => ({
  analysisApi: { listForProject: vi.fn() },
}));

vi.mock("@/lib/publishing-api", () => ({
  publishingApi: {
    listDrafts: vi.fn().mockResolvedValue([]),
    listBatches: vi.fn().mockResolvedValue([]),
    generateDrafts: vi.fn(),
    approveDraft: vi.fn(),
    createBatch: vi.fn(),
  },
}));

vi.mock("@/lib/connectors-api", () => ({
  repoConnectorsApi: { getPrimary: vi.fn().mockResolvedValue(null) },
}));

vi.mock("@/lib/change-analysis-api", () => ({
  publishDestinationApi: { get: vi.fn().mockResolvedValue(null), update: vi.fn() },
}));

import { analysisApi } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import { publishingApi } from "@/lib/publishing-api";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { publishDestinationApi } from "@/lib/change-analysis-api";
import PublishingPage from "@/app/(authed)/projects/[id]/publish/page";

const listForProjectMock = analysisApi.listForProject as unknown as ReturnType<typeof vi.fn>;
const generateMock = publishingApi.generateDrafts as unknown as ReturnType<typeof vi.fn>;

function makeAnalysis(over: Record<string, unknown> = {}) {
  return {
    id: "analysis_abcdef123456",
    projectId: "proj_1",
    startedById: "u1",
    status: "completed",
    startedAt: "2026-04-01T00:00:00.000Z",
    completedAt: "2026-04-01T00:05:00.000Z",
    totalTokens: 1000,
    errorMessage: null,
    ...over,
  };
}

beforeEach(() => {
  listForProjectMock.mockReset();
  generateMock.mockReset();
  generateMock.mockResolvedValue({ summary: { upserted: 1, refreshed: 0 } });
  listForProjectMock.mockResolvedValue({ items: [makeAnalysis()] });
});

describe("PublishingPage — analysis picker", () => {
  it("lists the project's analyses and selecting one drives draft generation with that id", async () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );

    const select = await screen.findByTestId("publish-analysis-select");
    // Option label is rendered for the analysis.
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /completed/ })).toBeInTheDocument(),
    );

    fireEvent.change(select, { target: { value: "analysis_abcdef123456" } });

    // Provide owner/repo so Generate is enabled, then trigger generation.
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await waitFor(() =>
      expect(generateMock).toHaveBeenCalledWith("proj_1", {
        analysisId: "analysis_abcdef123456",
        targetOwner: "acme",
        targetRepo: "app",
      }),
    );
  });

  it("#362 — a Generate blocked by pending approvals names them and links to where they are resolved", async () => {
    generateMock.mockRejectedValue(
      new ApiError(
        400,
        "analysis has no requirements yet — the approval gate is holding them (3 pending approval(s)); resolve them on the Analysis page",
        "APPROVALS_BLOCKING",
        {
          analysisId: "analysis_abcdef123456",
          pendingCount: 3,
          rejectedCount: 0,
          action: "resolve",
        },
      ),
    );
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
    const select = await screen.findByTestId("publish-analysis-select");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /completed/ })).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: "analysis_abcdef123456" } });
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    const error = await screen.findByTestId("generate-error");
    expect(error).toHaveTextContent("3 pending approval(s)");
    expect(error).not.toHaveTextContent("run analysis first");
    expect(screen.getByRole("link", { name: "Resolve approvals" })).toHaveAttribute(
      "href",
      "/projects/proj_1/analysis?analysisId=analysis_abcdef123456&tab=approvals#approvals",
    );
  });

  // PR #404 panel — a rejected approval is final, so the link is to a new run.
  it("#362 — a Generate blocked by a rejected approval offers a re-run, not approvals", async () => {
    generateMock.mockRejectedValue(
      new ApiError(
        400,
        "analysis has no requirements — 1 approval(s) were rejected, so this run cannot produce requirements; re-run the analysis",
        "APPROVALS_BLOCKING",
        {
          analysisId: "analysis_abcdef123456",
          pendingCount: 0,
          rejectedCount: 1,
          action: "rerun",
        },
      ),
    );
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
    const select = await screen.findByTestId("publish-analysis-select");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /completed/ })).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: "analysis_abcdef123456" } });
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findByTestId("generate-error");
    expect(screen.getByRole("link", { name: "Re-run analysis" })).toHaveAttribute(
      "href",
      "/projects/proj_1/analysis",
    );
    expect(screen.queryByRole("link", { name: "Resolve approvals" })).not.toBeInTheDocument();
  });

  it("#406 — ignores a server-supplied URL and offers no link without the run id", async () => {
    generateMock.mockRejectedValue(
      new ApiError(400, "blocked", "APPROVALS_BLOCKING", {
        action: "resolve",
        resolveUrl: "https://evil.example/",
      }),
    );
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
    const select = await screen.findByTestId("publish-analysis-select");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /completed/ })).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: "analysis_abcdef123456" } });
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    expect(await screen.findByTestId("generate-error")).toHaveTextContent("blocked");
    expect(screen.queryByRole("link", { name: "Resolve approvals" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href^="https:"]')).toBeNull();
  });

  it("#406 — builds the approvals link from the run id, encoded, with the Approvals tab", async () => {
    generateMock.mockRejectedValue(
      new ApiError(400, "blocked", "APPROVALS_BLOCKING", {
        analysisId: "a/../../evil?x=1#y",
        pendingCount: 1,
        rejectedCount: 0,
        action: "resolve",
      }),
    );
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
    const select = await screen.findByTestId("publish-analysis-select");
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /completed/ })).toBeInTheDocument(),
    );
    fireEvent.change(select, { target: { value: "analysis_abcdef123456" } });
    fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "app" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));

    await screen.findByTestId("generate-error");
    expect(screen.getByRole("link", { name: "Resolve approvals" })).toHaveAttribute(
      "href",
      "/projects/proj_1/analysis?analysisId=a%2F..%2F..%2Fevil%3Fx%3D1%23y&tab=approvals#approvals",
    );
  });

  it("shows an empty-state option when the project has no analyses", async () => {
    listForProjectMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
    const select = await screen.findByTestId("publish-analysis-select");
    await waitFor(() => expect(select).toHaveTextContent("No analyses yet"));
  });
});

// Issue #58 — screen-reader audit. Draft-selection checkboxes carry a
// per-draft accessible name (previously unlabelled — announced only as
// "checkbox"), the batches table headers are scoped columnheaders, and the
// actions column has an sr-only label.
describe("PublishingPage — screen-reader affordances (#58)", () => {
  it("labels each draft checkbox and scopes the batches table headers", async () => {
    (publishingApi.listDrafts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: "draft_1",
        title: "Add OAuth login",
        body: "…",
        draftType: "feature",
        storyPoints: 3,
        status: "draft",
        metadata: null,
      },
    ]);
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Publishing" })).toBeInTheDocument();

    // The draft checkbox is now reachable by its accessible name.
    const checkbox = await screen.findByRole("checkbox", { name: "Select draft: Add OAuth login" });
    expect(checkbox).toBeInTheDocument();

    // Batches table column headers are scoped, incl. the sr-only actions header.
    expect(screen.getByRole("columnheader", { name: "Status" })).toHaveAttribute("scope", "col");
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });
});

describe("PublishingPage — run labels and target pre-fill (#364, #733)", () => {
  const getPrimaryMock = repoConnectorsApi.getPrimary as unknown as ReturnType<typeof vi.fn>;
  const getDestMock = publishDestinationApi.get as unknown as ReturnType<typeof vi.fn>;
  const dest = (githubOwner: string | null, githubRepo: string | null) => ({
    publishDestination: "github",
    jiraProjectKey: null,
    jiraConnectionId: null,
    githubOwner,
    githubRepo,
  });

  function renderPage() {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <PublishingPage />
      </Wrapper>,
    );
  }

  it("labels analyses 'Run #N — <date>' with the short id last, oldest run = #1", async () => {
    listForProjectMock.mockResolvedValue({
      items: [
        makeAnalysis({ id: "cmumww553000newer", startedAt: "2026-04-02T00:00:00.000Z" }),
        makeAnalysis({ id: "cmumaa111000older", startedAt: "2026-04-01T00:00:00.000Z" }),
      ],
    });
    renderPage();
    const newer = await screen.findByRole("option", { name: /cmumww55/ });
    expect(newer.textContent).toMatch(/^Run #2 — .+ · completed · cmumww55$/);
    const older = screen.getByRole("option", { name: /cmumaa11/ });
    expect(older.textContent).toMatch(/^Run #1 — /);
  });

  it("#733 — fills owner and repo from the saved project target when they are empty", async () => {
    getDestMock.mockResolvedValueOnce(dest("openzigs", "flux-v2"));
    renderPage();
    await waitFor(() => expect(screen.getByLabelText("Target owner")).toHaveValue("openzigs"));
    expect(screen.getByLabelText("Target repo")).toHaveValue("flux-v2");
  });

  it("#733 — never fills the target from the analysed (primary) repository", async () => {
    getPrimaryMock.mockResolvedValueOnce({ ownerOrOrg: "miniflux", repoName: "v2" });
    getDestMock.mockResolvedValueOnce(dest(null, null));
    renderPage();
    await waitFor(() => expect(getPrimaryMock).toHaveBeenCalled());
    await waitFor(() => expect(getDestMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Target owner")).toHaveValue("");
    expect(screen.getByLabelText("Target repo")).toHaveValue("");
    expect(screen.getByTestId("publish-target-unset")).toBeInTheDocument();
  });

  it("never pairs a typed owner with the saved repo: a typed field suppresses the pre-fill", async () => {
    let resolveDest: (v: unknown) => void = () => {};
    getDestMock.mockReturnValueOnce(new Promise((r) => (resolveDest = r)));
    renderPage();
    const owner = await screen.findByLabelText("Target owner");
    fireEvent.change(owner, { target: { value: "my-org" } });
    resolveDest(dest("openzigs", "from-saved"));
    await waitFor(() => expect(getDestMock).toHaveBeenCalled());
    // Let the resolved query settle and the effect run.
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Target owner")).toHaveValue("my-org");
    expect(screen.getByLabelText("Target repo")).toHaveValue("");
  });

  it.each([
    [null, "from-saved"],
    ["openzigs", null],
  ])("does not pre-fill half a pair from a half-saved target (%s/%s)", async (o, r) => {
    getDestMock.mockResolvedValueOnce(dest(o, r));
    renderPage();
    await waitFor(() => expect(getDestMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.getByLabelText("Target owner")).toHaveValue("");
    expect(screen.getByLabelText("Target repo")).toHaveValue("");
  });

  it("does not refill fields the user cleared when the saved target refetches", async () => {
    getDestMock.mockResolvedValue(dest("openzigs", "flux-v2"));
    try {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const Wrapper = makeWrapper({ queryClient });
      render(
        <Wrapper>
          <PublishingPage />
        </Wrapper>,
      );
      await waitFor(() => expect(screen.getByLabelText("Target owner")).toHaveValue("openzigs"));
      fireEvent.change(screen.getByLabelText("Target owner"), { target: { value: "" } });
      fireEvent.change(screen.getByLabelText("Target repo"), { target: { value: "" } });
      const calls = getDestMock.mock.calls.length;
      // Changed data, so the refetch hands the page a new object (an identical
      // result is structurally shared and would never reach the effect at all).
      getDestMock.mockResolvedValue(dest("openzigs", "flux-v2-renamed"));
      await queryClient.refetchQueries({ queryKey: ["publishDestination"] });
      await waitFor(() => expect(getDestMock.mock.calls.length).toBeGreaterThan(calls));
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.getByLabelText("Target owner")).toHaveValue("");
      expect(screen.getByLabelText("Target repo")).toHaveValue("");
    } finally {
      getDestMock.mockResolvedValue(null);
    }
  });
});
