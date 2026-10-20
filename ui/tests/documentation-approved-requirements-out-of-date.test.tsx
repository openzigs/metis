/**
 * #1252 — a reader BRD without auto-update whose approved requirements were
 * approved or edited since its latest version says so, in plain language, and
 * offers a regenerate. The server decides (`approvedRequirementsOutOfDate` on
 * the detail response); the page shows it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
import DocumentationPage, {
  ApprovedRequirementsOutOfDateBanner,
} from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);
afterEach(() => vi.clearAllMocks());

describe("ApprovedRequirementsOutOfDateBanner (#1252)", () => {
  it("says, in plain language, that requirements changed since this version, and regenerates", () => {
    const onRegenerate = vi.fn();
    render(
      <ApprovedRequirementsOutOfDateBanner regenerating={false} onRegenerate={onRegenerate} />,
    );
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/out of date/i);
    expect(banner).toHaveTextContent(/approved or changed/i);
    expect(banner).toHaveTextContent(/since this version/i);
    // #1252 review 2 — it promises nothing it cannot keep. #1270 — an approval
    // or an edit no longer moves any other section's budget, so the other
    // sections are kept; it names the cases that still rewrite, at a cost.
    expect(banner).toHaveTextContent(/other sections are kept as they are/i);
    expect(banner).toHaveTextContent(/normally uses no AI model credits/i);
    expect(banner).toHaveTextContent(/only if the code or other material it is written from/i);
    expect(banner).toHaveTextContent(/un-approve the last requirement.*uses credits/i);
    expect(banner).toHaveTextContent(/written before this version of METIS.*once/i);
    // #1277 — the first regenerate after this version rewrites the sections the
    // model writes, once, at model cost (their prompts were reordered); it is
    // not "some of them" and it is not free.
    expect(banner).toHaveTextContent(
      /first regenerate after this version of METIS rewrites the sections the AI model writes, once, which uses credits/i,
    );
    expect(banner).not.toHaveTextContent(/may also rewrite some of its other sections/i);
    expect(banner).not.toHaveTextContent(/approving the first/i);
    expect(banner).not.toHaveTextContent(/may rewrite some of them/i);
    // No implementation words a business analyst does not use.
    expect(banner).not.toHaveTextContent(/snapshot|hash|fingerprint|input|auto-update check/i);
    fireEvent.click(screen.getByRole("button", { name: /^regenerate$/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("disables the button while a regenerate request is in flight", () => {
    render(<ApprovedRequirementsOutOfDateBanner regenerating onRegenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: /regenerating/i })).toBeDisabled();
  });
});

describe("DocumentationPage — an out-of-date reader BRD (#1252)", () => {
  const DOC_ID = "doc_1";
  const detail = (over: Record<string, unknown>) => ({
    id: DOC_ID,
    title: "Business requirements",
    scope: "full",
    status: "ready",
    autoUpdate: false,
    generatedAt: "2026-10-01T00:00:00.000Z",
    createdAt: "2026-10-01T00:00:00.000Z",
    content: "# BRD",
    errorMessage: null,
    versions: [{ id: "v1", version: 1, diffSummary: null, createdAt: "2026-10-01T00:00:00.000Z" }],
    ...over,
  });

  function setup(doc: Record<string, unknown>) {
    mockApiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
      if (path.endsWith(`/docs/${DOC_ID}/regenerate`) && init?.method === "POST")
        return { id: DOC_ID, status: "pending" };
      if (path.endsWith(`/docs/${DOC_ID}`)) return doc;
      if (path.endsWith("/docs")) return [{ ...doc, content: undefined }];
      return [];
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <DocumentationPage />
      </Wrapper>,
    );
  }

  it("marks the document out of date and POSTs /regenerate for it", async () => {
    setup(detail({ approvedRequirementsOutOfDate: true }));
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    expect(await screen.findByTestId("approved-requirements-out-of-date")).toHaveTextContent(
      /out of date/i,
    );
    fireEvent.click(screen.getByRole("button", { name: /^regenerate$/i }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/projects/proj_test/docs/${DOC_ID}/regenerate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows no mark when the document is up to date", async () => {
    setup(detail({ approvedRequirementsOutOfDate: false }));
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    await screen.findByTestId("markdown-previewer");
    expect(screen.queryByTestId("approved-requirements-out-of-date")).toBeNull();
  });
});
