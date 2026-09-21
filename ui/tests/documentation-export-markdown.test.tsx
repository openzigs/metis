/**
 * Documentation page — Markdown export button.
 *
 * Generated docs are stored as markdown internally; the documentation tab
 * offers a third export format ("markdown") alongside PDF + Word. These tests
 * assert the "Export Markdown" button renders in the doc detail view and that
 * clicking it drives the export handler with the "markdown" format (which opens
 * the `?format=markdown` download endpoint).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

// The doc detail view renders the markdown previewer, which uses
// IntersectionObserver (absent in jsdom). Stub it — these tests are about the
// export buttons, not the preview.
vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ markdown }: { markdown: string }) => (
    <div data-testid="markdown-previewer">{markdown}</div>
  ),
}));

// Mock apiFetch
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

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

const sampleDoc = {
  id: "doc_1",
  title: "My Doc",
  scope: "full",
  status: "ready",
  autoUpdate: false,
  generatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

const docDetail = {
  ...sampleDoc,
  content: "# My Doc\n\nHello world.\n",
  versions: [],
};

function mockEndpoints(status = "ready") {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (typeof path === "string" && /\/docs\/doc_1$/.test(path)) {
      return { ...docDetail, status };
    }
    if (typeof path === "string" && /\/docs$/.test(path)) {
      return [{ ...sampleDoc, status }];
    }
    return [];
  });
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
}

async function openDocDetail() {
  renderPage();
  const card = await screen.findByTestId("doc-card-doc_1");
  fireEvent.click(card);
  // Detail view loads — wait for the export buttons to appear.
  await screen.findByRole("button", { name: "Export Markdown" });
}

describe("DocumentationPage — Markdown export", () => {
  let openSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockEndpoints();
    openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    openSpy.mockRestore();
  });

  it("renders the Export Markdown button next to PDF and Word", async () => {
    await openDocDetail();
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Word" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeInTheDocument();
  });

  it("opens the export endpoint with format=markdown when clicked", async () => {
    await openDocDetail();
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    const calledUrl = openSpy.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/projects/proj_test/docs/doc_1/export");
    expect(calledUrl).toContain("format=markdown");
  });

  it("offers markdown export for degraded docs too", async () => {
    mockEndpoints("degraded");
    renderPage();
    const card = await screen.findByTestId("doc-card-doc_1");
    fireEvent.click(card);
    const btn = await screen.findByRole("button", { name: "Export Markdown" });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledTimes(1);
    });
    expect(openSpy.mock.calls[0][0] as string).toContain("format=markdown");
  });
});
