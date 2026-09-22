/**
 * #50 — a generation interrupted by a server restart is failed on the next
 * startup instead of spinning forever; the detail view explains why and offers
 * a one-click regenerate of the SAME document.
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
  FailedGenerationBanner,
} from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);
afterEach(() => vi.clearAllMocks());

describe("FailedGenerationBanner (#50)", () => {
  it("explains an interruption and regenerates in one click", () => {
    const onRegenerate = vi.fn();
    render(<FailedGenerationBanner interrupted onRegenerate={onRegenerate} regenerating={false} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/interrupted/i);
    expect(alert).toHaveTextContent(/restart/i);
    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it("shows a generic failure (never the raw server error) otherwise", () => {
    render(
      <FailedGenerationBanner interrupted={false} onRegenerate={vi.fn()} regenerating={false} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/generation failed/i);
    expect(alert).not.toHaveTextContent(/restart/i);
    expect(screen.getByRole("button", { name: /regenerate/i })).toBeEnabled();
  });

  it("disables the button while a regenerate request is in flight", () => {
    render(<FailedGenerationBanner interrupted onRegenerate={vi.fn()} regenerating />);
    expect(screen.getByRole("button", { name: /regenerat/i })).toBeDisabled();
  });
});

describe("DocumentationPage — failed document (#50)", () => {
  const DOC_ID = "doc_1";
  const detail = (over: Record<string, unknown>) => ({
    id: DOC_ID,
    title: "Arch",
    scope: "full",
    status: "failed",
    autoUpdate: false,
    generatedAt: null,
    createdAt: "2026-09-22T00:00:00.000Z",
    content: "",
    errorMessage: "Error: internal stack detail",
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

  it("shows the interruption and POSTs /regenerate for the same document", async () => {
    setup(detail({ interrupted: true }));
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    const alert = await screen.findByText(/generation was interrupted/i);
    expect(alert).toBeInTheDocument();
    expect(screen.queryByText(/internal stack detail/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^regenerate$/i }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/projects/proj_test/docs/${DOC_ID}/regenerate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows no failure banner for a ready document", async () => {
    setup(detail({ status: "ready", errorMessage: null, content: "# Doc" }));
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    await screen.findByTestId("markdown-previewer");
    expect(screen.queryByText(/generation failed|generation was interrupted/i)).toBeNull();
  });
});
