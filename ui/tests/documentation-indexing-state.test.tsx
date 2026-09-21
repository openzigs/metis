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
});
