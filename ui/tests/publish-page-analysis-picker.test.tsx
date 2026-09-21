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
