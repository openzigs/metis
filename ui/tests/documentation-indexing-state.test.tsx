import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {
    status: number;
    code: string | undefined;
    constructor(status: number, message: string, code?: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  },
}));

vi.mock("@/hooks/use-job-events", () => ({
  useProjectJobEvents: vi.fn(),
  useDocSectionProgress: vi.fn(() => ({})),
  useJobLifecycle: vi.fn(() => undefined),
}));

vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-previewer">{content}</div>
  ),
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("DocumentationPage — indexing state", () => {
  it("shows indexing state separately from generation status in the list and detail views", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs/doc_1")) {
        return {
          id: "doc_1",
          title: "Architecture Overview",
          scope: "full",
          status: "ready",
          indexing: {
            state: "pending",
            status: "processing",
            chunkCount: 0,
            errorMessage: null,
            processedAt: null,
          },
          autoUpdate: false,
          generatedAt: "2026-06-01T00:00:00.000Z",
          createdAt: "2026-06-01T00:00:00.000Z",
          content: "# Architecture",
          versions: [],
        };
      }
      if (typeof path === "string" && path.endsWith("/docs")) {
        return [
          {
            id: "doc_1",
            title: "Architecture Overview",
            scope: "full",
            status: "ready",
            indexing: {
              state: "pending",
              status: "processing",
              chunkCount: 0,
              errorMessage: null,
              processedAt: null,
            },
            autoUpdate: false,
            generatedAt: "2026-06-01T00:00:00.000Z",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });

    renderPage();

    const card = await screen.findByTestId("doc-card-doc_1");
    expect(card).toHaveTextContent("ready");
    expect(card).toHaveTextContent("pending");

    fireEvent.click(card);

    expect(await screen.findByTestId("doc-indexing-summary")).toHaveTextContent(
      "Queued for indexing.",
    );
    expect(screen.getAllByTestId("doc-indexing-badge")[0]).toHaveTextContent("pending");
    expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Architecture");
  });

  // #489 — a cancelled publication's badge says "cancelled", in the neutral
  // tone, beside the cancelled message — not "failed" in the destructive one.
  it("renders a cancelled publication's badge as cancelled, not failed", async () => {
    const cancelledMessage =
      "Publishing this revision was cancelled before it finished, so it was not indexed.";
    const indexing = {
      state: "cancelled",
      status: "cancelled",
      chunkCount: 0,
      errorMessage: cancelledMessage,
      processedAt: null,
    };
    const doc = {
      id: "doc_1",
      title: "Architecture Overview",
      scope: "full",
      status: "ready",
      indexing,
      autoUpdate: false,
      generatedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs/doc_1")) {
        return { ...doc, content: "# Architecture", versions: [] };
      }
      if (typeof path === "string" && path.endsWith("/docs")) return [doc];
      return [];
    });

    renderPage();

    const card = await screen.findByTestId("doc-card-doc_1");
    const listBadge = card.querySelector('[data-testid="doc-indexing-badge"]');
    expect(listBadge).toHaveTextContent(/^cancelled$/);
    expect(listBadge).not.toHaveClass("text-destructive");
    expect(listBadge).toHaveClass("text-muted-foreground");

    fireEvent.click(card);

    expect(await screen.findByTestId("doc-indexing-summary")).toHaveTextContent(cancelledMessage);
    for (const badge of screen.getAllByTestId("doc-indexing-badge")) {
      expect(badge).toHaveTextContent(/^cancelled$/);
      expect(badge).not.toHaveClass("text-destructive");
    }
  });
  // #489 — a cancelled publication with no message must not read as queued.
  it("summarises a cancelled publication with no message as cancelled, not queued", async () => {
    const doc = {
      id: "doc_1",
      title: "Architecture Overview",
      scope: "full",
      status: "ready",
      indexing: {
        state: "cancelled",
        status: "cancelled",
        chunkCount: 0,
        errorMessage: null,
        processedAt: null,
      },
      autoUpdate: false,
      generatedAt: "2026-06-01T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    };
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs/doc_1")) {
        return { ...doc, content: "# Architecture", versions: [] };
      }
      if (typeof path === "string" && path.endsWith("/docs")) return [doc];
      return [];
    });

    renderPage();

    fireEvent.click(await screen.findByTestId("doc-card-doc_1"));

    const summary = await screen.findByTestId("doc-indexing-summary");
    expect(summary).toHaveTextContent("Publishing was cancelled.");
    expect(summary).not.toHaveTextContent("Queued for indexing.");
  });
});
