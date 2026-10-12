/**
 * #1061 — names the schema check could not match are information on a document
 * that is `ready`. The page shows one neutral status line for them and never
 * the degraded-output banner, which is mounted for `degraded` documents only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj_test" })),
}));

vi.mock("@/lib/api-client", () => ({
  apiFetch: vi.fn(),
  ApiError: class extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
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
afterEach(() => vi.clearAllMocks());

const DOC_ID = "doc_1";
const NOTE = {
  kind: "schema-unverified",
  section: "Data Architecture",
  severity: "info",
  message:
    "4 names in Data Architecture could not be matched to the database schema (jobs, " +
    "certificate_cache, feeds.error_counter, entries.category_id). Nothing was removed or changed.",
};
const SHORT = {
  kind: "section-ungrounded",
  section: "Business Rules",
  severity: "warning",
  tier: "literal",
  ratio: 0.5,
  threshold: 0.8,
  message: 'Section "Business Rules" is 50% grounded.',
};

async function open(doc: Record<string, unknown>): Promise<void> {
  const detail = {
    id: DOC_ID,
    title: "Architecture",
    scope: "full",
    autoUpdate: false,
    generatedAt: "2026-10-12T00:00:00.000Z",
    createdAt: "2026-10-12T00:00:00.000Z",
    content: "# Doc",
    errorMessage: null,
    ...doc,
  };
  mockApiFetch.mockImplementation(async (path: string) => {
    if (path.endsWith(`/docs/${DOC_ID}`)) return detail;
    if (path.endsWith("/docs")) return [{ ...detail, content: undefined }];
    return [];
  });
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <DocumentationPage />
    </Wrapper>,
  );
  fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
  await screen.findByTestId("markdown-previewer");
}

describe("DocumentationPage — names not matched to the database schema (#1061)", () => {
  it("a ready document shows the note as information, and no degraded banner", async () => {
    await open({ status: "ready", warnings: [NOTE] });
    const note = screen.getByTestId("schema-names-note");
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(
      "4 names in Data Architecture could not be matched to the database schema",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/code-fidelity bar/)).toBeNull();
  });

  it("a ready document without one shows neither", async () => {
    await open({ status: "ready", warnings: null });
    expect(screen.queryByTestId("schema-names-note")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a document degraded for another reason shows both, each saying its own thing", async () => {
    await open({ status: "degraded", warnings: [NOTE, SHORT] });
    expect(screen.getByTestId("schema-names-note")).toHaveTextContent(
      "4 names in Data Architecture",
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/"Business Rules" falls short of the code-fidelity bar/);
    expect(alert).not.toHaveTextContent(/Data Architecture/);
  });
});
