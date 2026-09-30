/**
 * Publishing page — analysis source picker (usability quick win).
 *
 * Replaces the free-text "Analysis ID" input with a dropdown of the project's
 * analyses (via the existing analysisApi.listForProject client). Selecting an
 * analysis drives draft generation with that id.
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

import { analysisApi } from "@/lib/analysis-api";
import { ApiError } from "@/lib/api-client";
import { publishingApi } from "@/lib/publishing-api";
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
