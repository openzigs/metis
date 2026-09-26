/**
 * Documentation page — version-history viewing follow-up.
 *
 * Verifies the Version History card:
 *  - renders when the doc detail payload includes a `versions` array (>= 1),
 *  - marks the current/latest version,
 *  - lets a user view a previous version's content read-only — #190: the body
 *    is fetched from its own endpoint only when the user opens that version,
 *  - fetches a version's changed symbols and provenance only when the matching
 *    panel is opened (#190),
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
const VERSION_BODIES: Record<string, string> = {
  v3: "# Version 3 body",
  v2: "# Version 2 body",
};

/** #196 — the panel reads the summary endpoint, never the full manifest. */
const PROVENANCE_SUMMARY = {
  revisionId: "gendoc:proj_test:doc_1:v2",
  version: 2,
  generatedAt: "2026-06-02T00:00:00.000Z",
  pipeline: "holistic",
  models: { phase1: "fact-model", phase2: "prose-model" },
  sectionCount: 4,
  selectedEvidenceCount: 2,
  sourceCount: 3,
  historicalCitations: { status: "unknown", mode: "legacy-unknown" },
  legacy: { historicalCitations: "legacy-unknown" },
};
const FULL_MANIFEST = { revision: { revisionId: "gendoc:proj_test:doc_1:v2" }, sections: [] };

function setup(detail: Record<string, unknown>) {
  mockApiFetch.mockImplementation(async (path: string) => {
    if (typeof path === "string" && path.endsWith(`/docs/${DOC_ID}`)) return detail;
    const version = /\/docs\/doc_1\/versions\/([^/?]+)(\/[^?]*)?(\?.*)?$/.exec(path);
    if (version) {
      const [, id, sub, query] = version;
      if (!sub) return { id, content: VERSION_BODIES[id] };
      if (sub === "/provenance/summary") return PROVENANCE_SUMMARY;
      if (sub === "/provenance") return FULL_MANIFEST;
      if (sub === "/changed-symbols") {
        expect(query).toBe("?limit=200");
        return { total: 1234, offset: 0, items: ["billing.Invoice.total", "billing.Tax.rate"] };
      }
    }
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
          },
          {
            id: "v2",
            version: 2,
            diffSummary: "Added schema",
            createdAt: "2026-06-02T00:00:00.000Z",
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

  it("fetches a previous version's body only when the user opens it (#190)", async () => {
    setup(
      docDetail({
        content: "# Latest content",
        versions: [
          {
            id: "v3",
            version: 3,
            diffSummary: "Latest",
            createdAt: "2026-06-03T00:00:00.000Z",
          },
          {
            id: "v2",
            version: 2,
            diffSummary: "Older",
            createdAt: "2026-06-02T00:00:00.000Z",
          },
        ],
      }),
    );
    await openDoc();

    // Initially the latest content is shown, and no version body was fetched.
    expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");
    const versionCalls = () =>
      mockApiFetch.mock.calls.filter(([path]) => String(path).includes("/versions/"));
    expect(versionCalls()).toHaveLength(0);

    // Click the older (non-current) version to view it.
    const section = screen.getByTestId("version-history");
    const olderRow = within(section).getAllByRole("listitem")[1];
    fireEvent.click(within(olderRow).getByText(/Older|view/i));

    await waitFor(() => {
      expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Version 2 body");
    });
    expect(versionCalls().map(([path]) => path)).toEqual([
      `/projects/proj_test/docs/${DOC_ID}/versions/v2`,
    ]);
    expect(screen.getByTestId("version-view-banner")).toHaveTextContent("Viewing v2");

    // A way back to the latest exists.
    fireEvent.click(screen.getByTestId("version-history-back-to-latest"));
    await waitFor(() => {
      expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");
    });
  });

  it("says so when a previous version's body cannot be loaded", async () => {
    setup(
      docDetail({
        versions: [
          { id: "v3", version: 3, diffSummary: "Latest", createdAt: "2026-06-03T00:00:00.000Z" },
          { id: "gone", version: 2, diffSummary: "Older", createdAt: "2026-06-02T00:00:00.000Z" },
        ],
      }),
    );
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (String(path).endsWith("/versions/gone")) throw new Error("404");
      return (base as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    });
    await openDoc();
    const olderRow = within(screen.getByTestId("version-history")).getAllByRole("listitem")[1];
    fireEvent.click(within(olderRow).getByText(/Older/));
    expect(await screen.findByText("Could not load v2.")).toBeInTheDocument();
  });

  it("fetches changed symbols and provenance only when their panel is opened (#190)", async () => {
    setup(
      docDetail({
        versions: [
          { id: "v2", version: 2, diffSummary: "Latest", createdAt: "2026-06-02T00:00:00.000Z" },
        ],
      }),
    );
    await openDoc();
    const artifactCalls = () =>
      mockApiFetch.mock.calls
        .map(([path]) => String(path))
        .filter((path) => /changed-symbols|provenance/.test(path));
    expect(artifactCalls()).toEqual([]);

    fireEvent.click(screen.getByTestId("version-symbols-toggle-v2"));
    const symbols = await screen.findByTestId("version-symbols-v2");
    expect(await within(symbols).findByText("1,234 changed symbols in v2")).toBeInTheDocument();
    expect(within(symbols).getByText("billing.Invoice.total")).toBeInTheDocument();
    expect(within(symbols).getByText("Showing the first 2.")).toBeInTheDocument();
    expect(artifactCalls()).toEqual([
      `/projects/proj_test/docs/${DOC_ID}/versions/v2/changed-symbols?limit=200`,
    ]);

    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    const provenance = await screen.findByTestId("version-provenance-v2");
    expect(await within(provenance).findByText("gendoc:proj_test:doc_1:v2")).toBeInTheDocument();
    expect(within(provenance).getByText("holistic")).toBeInTheDocument();
    expect(within(provenance).getByText(/fact-model/)).toBeInTheDocument();
    expect(within(provenance).getByText("2 selected from 3 sources")).toBeInTheDocument();
    expect(within(provenance).getByText("4")).toBeInTheDocument();
    // Opening one panel closes the other.
    expect(screen.queryByTestId("version-symbols-v2")).not.toBeInTheDocument();
    // #196 — the summary, not the (tens of megabytes) manifest.
    expect(artifactCalls()).toEqual([
      `/projects/proj_test/docs/${DOC_ID}/versions/v2/changed-symbols?limit=200`,
      `/projects/proj_test/docs/${DOC_ID}/versions/v2/provenance/summary`,
    ]);

    // Closing and re-opening reuses the fetched artifact (versions are immutable).
    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    expect(screen.queryByTestId("version-provenance-v2")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    await screen.findByText("gendoc:proj_test:doc_1:v2");
    expect(artifactCalls()).toHaveLength(2);
  });

  it("fetches the full manifest only when the user downloads it (#196)", async () => {
    const createObjectURL = vi.fn((_blob: Blob) => "blob:manifest");
    const revokeObjectURL = vi.fn();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    setup(
      docDetail({
        versions: [
          { id: "v2", version: 2, diffSummary: "Latest", createdAt: "2026-06-02T00:00:00.000Z" },
        ],
      }),
    );
    await openDoc();
    const manifestCalls = () =>
      mockApiFetch.mock.calls
        .map(([path]) => String(path))
        .filter((p) => p.endsWith("/provenance"));

    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    const panel = await screen.findByTestId("version-provenance-v2");
    await within(panel).findByText("gendoc:proj_test:doc_1:v2");
    expect(manifestCalls()).toEqual([]);

    fireEvent.click(within(panel).getByRole("button", { name: "Download full manifest" }));
    await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
    expect(manifestCalls()).toEqual([`/projects/proj_test/docs/${DOC_ID}/versions/v2/provenance`]);
    const blob = createObjectURL.mock.calls[0][0];
    expect(JSON.parse(await blob.text())).toEqual(FULL_MANIFEST);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:manifest");
    click.mockRestore();
  });

  it("says so when the full manifest cannot be downloaded (#196)", async () => {
    setup(
      docDetail({
        versions: [
          { id: "v2", version: 2, diffSummary: "Latest", createdAt: "2026-06-02T00:00:00.000Z" },
        ],
      }),
    );
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (String(path).endsWith("/provenance")) throw new Error("500");
      return (base as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    });
    await openDoc();
    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    const panel = await screen.findByTestId("version-provenance-v2");
    fireEvent.click(await within(panel).findByRole("button", { name: "Download full manifest" }));
    expect(await within(panel).findByText("Could not download the manifest.")).toBeInTheDocument();
  });

  it("reports an artifact that fails to load", async () => {
    setup(
      docDetail({
        versions: [
          { id: "v2", version: 2, diffSummary: "Latest", createdAt: "2026-06-02T00:00:00.000Z" },
        ],
      }),
    );
    const base = mockApiFetch.getMockImplementation()!;
    mockApiFetch.mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (/changed-symbols|provenance/.test(String(path))) throw new Error("500");
      return (base as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    });
    await openDoc();
    fireEvent.click(screen.getByTestId("version-symbols-toggle-v2"));
    expect(await screen.findByText("Could not load the changed symbols.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("version-provenance-toggle-v2"));
    expect(await screen.findByText("Could not load the provenance manifest.")).toBeInTheDocument();
  });

  it("does not render the version-history section (no fake history) when versions are absent", async () => {
    setup(docDetail({ versions: undefined }));
    await openDoc();

    expect(screen.queryByTestId("version-history")).not.toBeInTheDocument();
    // The page still rendered the latest content; no crash.
    expect(screen.getByTestId("markdown-previewer")).toHaveTextContent("Latest content");
  });
});
