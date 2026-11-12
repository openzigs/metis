/**
 * #2183 — a finished BRD read "Indexing: pending — Queued for indexing" until a
 * reload. Publication runs as its own scheduler task after the generation job
 * ends, and that job's terminal event was the page's last refresh. The page now
 * reads a just-finished document again until its index settles, and only for
 * a bounded window after it was generated.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));
vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ markdown }: { markdown: string }) => (
    <div data-testid="markdown-previewer">{markdown}</div>
  ),
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

import { apiFetch } from "@/lib/api-client";
import DocumentationPage, {
  INDEXING_POLL_MS,
  INDEXING_POLL_WINDOW_MS,
  indexingInFlight,
  indexingPollInterval,
} from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);
const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const pending = { state: "pending", status: "pending", chunkCount: 0, errorMessage: null };
const indexed = { state: "indexed", status: "ready", chunkCount: 74, errorMessage: null };

describe("indexingInFlight / indexingPollInterval", () => {
  const doc = (over: Record<string, unknown> = {}) => ({
    status: "ready",
    generatedAt: iso(30_000),
    indexing: pending,
    ...over,
  });

  it("polls a document generated just now whose index is still pending", () => {
    expect(indexingInFlight(doc(), NOW)).toBe(true);
    // No indexing projection reads as queued, as the summary says.
    expect(indexingInFlight(doc({ indexing: undefined }), NOW)).toBe(true);
    expect(indexingInFlight(doc({ status: "degraded" }), NOW)).toBe(true);
    expect(indexingPollInterval([doc({ indexing: indexed }), doc()], NOW)).toBe(INDEXING_POLL_MS);
  });

  it("stops once the index settles, either way", () => {
    for (const state of ["indexed", "quarantined", "rejected", "failed", "cancelled"]) {
      expect(indexingInFlight(doc({ indexing: { ...pending, state } }), NOW)).toBe(false);
    }
    expect(indexingPollInterval([doc({ indexing: indexed })], NOW)).toBe(false);
  });

  it("never polls a document still generating, or one that cannot be exported", () => {
    expect(indexingInFlight(doc({ status: "generating", generatedAt: null }), NOW)).toBe(false);
    expect(indexingInFlight(doc({ status: "failed" }), NOW)).toBe(false);
    expect(indexingInFlight(undefined, NOW)).toBe(false);
    expect(indexingPollInterval(undefined, NOW)).toBe(false);
    expect(indexingPollInterval([], NOW)).toBe(false);
  });

  it("stops after the window, so a document that never indexes is not polled forever", () => {
    expect(indexingInFlight(doc({ generatedAt: iso(INDEXING_POLL_WINDOW_MS - 1) }), NOW)).toBe(
      true,
    );
    expect(indexingInFlight(doc({ generatedAt: iso(INDEXING_POLL_WINDOW_MS) }), NOW)).toBe(false);
    expect(indexingInFlight(doc({ generatedAt: "not a date" }), NOW)).toBe(false);
  });
});

describe("DocumentationPage — a just-finished BRD's index", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("reads the document again until it is indexed, then stops", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
    let index: Record<string, unknown> = pending;
    const base = {
      id: "doc_1",
      title: "BRD",
      scope: "full",
      status: "ready",
      autoUpdate: false,
      generatedAt: iso(20_000),
      createdAt: iso(1_000_000),
    };
    mockApiFetch.mockImplementation(async (path: string) => {
      if (/\/docs\/doc_1$/.test(path)) {
        return { ...base, content: "# BRD\n", versions: [], indexing: index };
      }
      if (/\/docs$/.test(path)) return [{ ...base, indexing: index }];
      return [];
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <DocumentationPage />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByTestId("doc-card-doc_1"));
    expect(await screen.findByTestId("doc-indexing-summary")).toHaveTextContent(
      "Queued for indexing.",
    );

    // The publication task finishes; no socket event says so.
    index = indexed;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS + 100);
    });
    expect(await screen.findByText("74 sections indexed.")).toBeInTheDocument();

    const detailReads = () =>
      mockApiFetch.mock.calls.filter(([p]) => /\/docs\/doc_1$/.test(String(p))).length;
    const settled = detailReads();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(INDEXING_POLL_MS * 3);
    });
    expect(detailReads()).toBe(settled);
  });
});
