/**
 * Documentation page — version-history viewing follow-up.
 *
 * Verifies the Version History card:
 *  - renders when the doc detail payload includes a `versions` array (>= 1),
 *  - marks the current/latest version,
 *  - lets a user view a previous version's content read-only (the content is
 *    already in the API payload — no extra fetch),
 *  - is NOT rendered (and does not crash / fabricate history) when the payload
 *    has no versions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

// Live job-event hooks are irrelevant to version-history rendering — stub them.
vi.mock("@/hooks/use-job-events", () => ({
  useProjectJobEvents: vi.fn(),
  useDocSectionProgress: vi.fn(() => ({})),
  useJobLifecycle: vi.fn(() => undefined),
}));

// Render markdown content verbatim so we can assert which version is shown.
vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-previewer">{content}</div>
  ),
}));

import { apiFetch } from "@/lib/api-client";
import DocumentationPage from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);

const DOC_ID = "doc_1";

function docDetail(overrides: Record<string, unknown> = {}) {
  return {
    id: DOC_ID,
    title: "My Doc",
    scope: "full",
    status: "ready",
    autoUpdate: false,
    generatedAt: "2026-06-01T00:00:00.000Z",
    createdAt: "2026-06-01T00:00:00.000Z",
    content: "# Latest content",
    ...overrides,
  };
}

/**
 * Wire apiFetch so the docs list returns one card and the detail call returns
 * `detail`. Returns a render helper that selects the doc to open the detail view.
 */
function setup(detail: Record<string, unknown>) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.endsWith(`/docs/${DOC_ID}`)) return detail;
    if (typeof path === "string" && path.endsWith("/docs")) {
      return [
        {
          id: DOC_ID,
          title: "My Doc",
          scope: "full",
          status: "ready",
          autoUpdate: false,
          generatedAt: null,
          createdAt: "2026-06-01T00:00:00.000Z",
        },
      ];
    }
    return [];
  });

  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
}

async function openDoc() {
  fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
  // Detail loaded once the latest content shows.
  await screen.findByTestId("markdown-previewer");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("DocumentationPage — version history", () => {
  beforeEach(() => {
    mockApiFetch.mockReset();
  });

  it("renders the version-history section when versions are present and marks the latest", async () => {
    setup(
      docDetail({
        versions: [
          {
            id: "v3",
            version: 3,
            diffSummary: "Refined overview",
            createdAt: "2026-06-03T00:00:00.000Z",
            content: "# Version 3",
          },
          {
            id: "v2",
            version: 2,
            diffSummary: "Added schema",
            createdAt: "2026-06-02T00:00:00.000Z",
            content: "# Version 2",
          },
        ],
      }),
    );
    await openDoc();

    const section = await screen.findByTestId("version-history");
    expect(section).toBeInTheDocument();
    // Latest version (highest number = first row) is marked Current/Latest.
    const rows = within(section).getAllByRole("listitem");
    expect(within(rows[0]).getByText(/current|latest/i)).toBeInTheDocument();
    // The older version row is not labelled current/latest.
    expect(within(rows[1]).queryByText(/current|latest/i)).not.toBeInTheDocument();
    // Both versions and their diff summaries are listed.
    expect(within(section).getByText(/v3/)).toBeInTheDocument();
    expect(within(section).getByText(/Refined overview/)).toBeInTheDocument();
    expect(within(section).getByText(/Added schema/)).toBeInTheDocument();
  });

  it("renders the version-history section for a single version too", async () => {
    setup(
      docDetail({
        versions: [
          {
            id: "v1",
            version: 1,
            diffSummary: null,
            createdAt: "2026-06-01T00:00:00.000Z",
            content: "# Version 1",
          },
        ],
      }),
    );
    await openDoc();

    const section = await screen.findByTestId("version-history");
    expect(section).toBeInTheDocument();
    // No diffSummary → honest fallback label.
    expect(within(section).getByText(/Full generation/)).toBeInTheDocument();
  });

  it("lets the user view a previous version's content read-only without an extra fetch", async () => {
    setup(
      docDetail({
        content: "# Latest content",
        versions: [
          {
            id: "v3",
            version: 3,
            diffSummary: "Latest",
            createdAt: "2026-06-03T00:00:00.000Z",
            content: "# Version 3 body",
          },
          {
            id: "v2",
            version: 2,
            diffSummary: "Older",
            createdAt: "2026-06-02T00:00:00.000Z",
            content: "# Version 2 body",
          },
        ],
      }),
    );
    await openDoc();

    // Initially the latest content is shown.
    expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");

    const callsBefore = mockApiFetch.mock.calls.length;

    // Click the older (non-current) version to view it.
    const section = screen.getByTestId("version-history");
    const olderRow = within(section).getAllByRole("listitem")[1];
    fireEvent.click(within(olderRow).getByText(/Older|view/i));

    await waitFor(() => {
      expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Version 2 body");
    });
    // No additional API call — content came from the existing payload.
    expect(mockApiFetch.mock.calls.length).toBe(callsBefore);

    // A way back to the latest exists.
    fireEvent.click(screen.getByTestId("version-history-back-to-latest"));
    await waitFor(() => {
      expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");
    });
  });

  it("does not render the version-history section (no fake history) when versions are absent", async () => {
    setup(docDetail({ versions: undefined }));
    await openDoc();

    expect(screen.queryByTestId("version-history")).not.toBeInTheDocument();
    // The page still rendered the latest content; no crash.
    expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");
  });
});
