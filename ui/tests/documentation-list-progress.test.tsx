/**
 * Epic #406 (#420) — documentation LIST live-progress + auto-nav tests.
 *
 * Verifies:
 *  - list-card-shows-progress: a `generating` doc card shows LIVE progress
 *    (percent + "N of M sections" counter + a progress bar) driven by the
 *    job:lifecycle + job:doc-section bus, NOT just the static "generating" badge.
 *  - the counter falls back to the lifecycle message when the bus has not yet
 *    reported a section total (preserves the existing affordance, no crash).
 *  - auto-nav-on-trigger: triggering generation navigates to the new doc's
 *    detail view (which renders the rich GenerationProgress) and fires a toast
 *    with a "view progress" action.
 *  - a `ready` doc card shows NO list progress (only generating docs do).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DocSectionProgressEvent, JobLifecycleEvent } from "@metis/shared";
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

// Drive the live job-event hooks from the test. `useJobLifecycle` /
// `useDocSectionProgress` feed the list card's DocListProgress; the page-level
// `useProjectJobEvents` is irrelevant here.
const jobLifecycleMock = vi.fn<(jobId: string | null | undefined) => JobLifecycleEvent | null>();
const docSectionMock =
  vi.fn<(jobId: string | null | undefined) => Record<string, DocSectionProgressEvent>>();

vi.mock("@/hooks/use-job-events", () => ({
  useProjectJobEvents: vi.fn(),
  useJobLifecycle: (jobId: string | null | undefined) => jobLifecycleMock(jobId),
  useDocSectionProgress: (jobId: string | null | undefined) => docSectionMock(jobId),
}));

const toastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: vi.fn(),
  },
}));

vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-previewer">{content}</div>
  ),
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

function section(over: Partial<DocSectionProgressEvent>): DocSectionProgressEvent {
  return {
    jobId: "doc_gen",
    projectId: "proj_test",
    section: "Overview",
    status: "generating",
    ts: 1,
    ...over,
  };
}

beforeEach(() => {
  mockApiFetch.mockReset();
  jobLifecycleMock.mockReset();
  docSectionMock.mockReset();
  toastSuccess.mockReset();
  jobLifecycleMock.mockReturnValue(null);
  docSectionMock.mockReturnValue({});
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
}

describe("DocumentationPage — list-card live progress (#420)", () => {
  it("shows live % + 'N of M sections' progress on a generating doc card, not just a badge", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs")) {
        return [
          {
            id: "doc_gen",
            title: "Generating Doc",
            scope: "full",
            status: "generating",
            autoUpdate: false,
            generatedAt: null,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    // Bus reports overall 55% and 3 of 5 sections finished.
    jobLifecycleMock.mockReturnValue({
      kind: "doc-generation",
      jobId: "doc_gen",
      projectId: "proj_test",
      status: "progress",
      progress: 55,
      ts: 2,
    });
    docSectionMock.mockReturnValue({
      Overview: section({ section: "Overview", status: "done", index: 1, total: 5 }),
      Domain: section({ section: "Domain", status: "done", index: 2, total: 5 }),
      Risks: section({ section: "Risks", status: "degraded", index: 3, total: 5 }),
      Data: section({ section: "Data", status: "generating", index: 4, total: 5 }),
    });

    renderPage();

    const progress = await screen.findByTestId("doc-list-progress-doc_gen");
    expect(within(progress).getByTestId("doc-list-progress-counter-doc_gen")).toHaveTextContent(
      "3 of 5 sections",
    );
    expect(within(progress).getByTestId("doc-list-progress-pct-doc_gen")).toHaveTextContent("55%");
    // It is more than just the static badge.
    expect(progress.querySelector('[role="progressbar"], [data-state]')).not.toBeNull();
  });

  it("falls back to the lifecycle message when the bus has no section total yet", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs")) {
        return [
          {
            id: "doc_gen",
            title: "Early Doc",
            scope: "full",
            status: "generating",
            autoUpdate: false,
            generatedAt: null,
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    jobLifecycleMock.mockReturnValue({
      kind: "doc-generation",
      jobId: "doc_gen",
      projectId: "proj_test",
      status: "started",
      message: "Loading… (9 of 51 tables)",
      ts: 2,
    });
    docSectionMock.mockReturnValue({});

    renderPage();

    const counter = await screen.findByTestId("doc-list-progress-counter-doc_gen");
    expect(counter).toHaveTextContent("Loading… (9 of 51 tables)");
  });

  it("does NOT show list progress for a ready doc", async () => {
    mockApiFetch.mockImplementation(async (path: string) => {
      if (typeof path === "string" && path.endsWith("/docs")) {
        return [
          {
            id: "doc_ready",
            title: "Ready Doc",
            scope: "full",
            status: "ready",
            autoUpdate: false,
            generatedAt: "2026-06-02T00:00:00.000Z",
            createdAt: "2026-06-01T00:00:00.000Z",
          },
        ];
      }
      return [];
    });
    renderPage();

    await screen.findByTestId("doc-card-doc_ready");
    expect(screen.queryByTestId("doc-list-progress-doc_ready")).not.toBeInTheDocument();
  });
});

describe("DocumentationPage — auto-nav on generate (#420)", () => {
  it("navigates to the new generating doc's detail and toasts a 'view progress' action", async () => {
    // List starts empty; the generate POST returns the freshly-created doc; the
    // subsequent detail GET returns that doc in a generating state.
    mockApiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (typeof path === "string" && path.endsWith("/docs/generate") && init?.method === "POST") {
        return {
          id: "doc_new",
          title: "Business Requirements",
          scope: "full",
          status: "generating",
          autoUpdate: false,
          generatedAt: null,
          createdAt: "2026-06-10T00:00:00.000Z",
        };
      }
      if (typeof path === "string" && path.endsWith("/docs/doc_new")) {
        return {
          id: "doc_new",
          title: "Business Requirements",
          scope: "full",
          status: "generating",
          autoUpdate: false,
          generatedAt: null,
          createdAt: "2026-06-10T00:00:00.000Z",
        };
      }
      if (typeof path === "string" && path.endsWith("/docs")) return [];
      return [];
    });
    docSectionMock.mockReturnValue({});
    jobLifecycleMock.mockReturnValue(null);

    renderPage();

    // Open the modal and submit.
    fireEvent.click(await screen.findByTestId("generate-docs-btn"));
    fireEvent.click(await screen.findByTestId("submit-generate"));

    // Auto-navigated to the new doc's detail view — the generating banner shows.
    await waitFor(() => {
      expect(screen.getByTestId("generation-progress")).toBeInTheDocument();
    });

    // A toast with a "view progress" action was fired (not the generic message).
    expect(toastSuccess).toHaveBeenCalled();
    const [, opts] = toastSuccess.mock.calls[0] as [string, { action?: { label?: string } }];
    expect(opts?.action?.label).toMatch(/view progress/i);
  });
});
