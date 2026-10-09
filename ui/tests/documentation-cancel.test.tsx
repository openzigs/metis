/**
 * #855 — a running documentation generation can be cancelled from its card or
 * its detail view, and a cancelled one says so and regenerates to finish.
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

// #980 — observe the header indicator's store being told about the cancel.
vi.mock("@/hooks/use-active-jobs", async (orig) => ({
  ...(await orig<typeof import("@/hooks/use-active-jobs")>()),
  dismissActiveJob: vi.fn(),
}));

vi.mock("@/components/markdown-previewer", () => ({
  MarkdownPreviewer: ({ content }: { content: string }) => (
    <div data-testid="markdown-previewer">{content}</div>
  ),
}));

import { apiFetch } from "@/lib/api-client";
import { dismissActiveJob } from "@/hooks/use-active-jobs";
import DocumentationPage, {
  CancelGenerationButton,
  CancelledGenerationBanner,
  isCancellable,
} from "@/app/(authed)/projects/[id]/documentation/page";

const mockApiFetch = vi.mocked(apiFetch);
afterEach(() => vi.clearAllMocks());

const DOC_ID = "doc_9";
const base = {
  id: DOC_ID,
  title: "BRD",
  scope: "full",
  autoUpdate: false,
  generatedAt: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  content: "",
  versions: [],
};

function setup(doc: Record<string, unknown>) {
  mockApiFetch.mockImplementation(async (path: string, init?: { method?: string }) => {
    if (path.endsWith(`/docs/${DOC_ID}/cancel`) && init?.method === "POST")
      return { id: DOC_ID, status: "cancelling" };
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

const cancelCalls = () =>
  mockApiFetch.mock.calls.filter(([path]) => String(path).endsWith(`/docs/${DOC_ID}/cancel`));

describe("isCancellable", () => {
  it("is true only while a generation is queued, running or stopping", () => {
    for (const s of ["pending", "generating", "cancelling"]) expect(isCancellable(s)).toBe(true);
    for (const s of ["ready", "degraded", "failed", "cancelled"])
      expect(isCancellable(s)).toBe(false);
  });
});

describe("CancelGenerationButton", () => {
  it("cancels once, and shows that it is stopping", () => {
    const onCancel = vi.fn();
    const { rerender } = render(
      <CancelGenerationButton status="generating" pending={false} onCancel={onCancel} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    expect(onCancel).toHaveBeenCalledOnce();
    rerender(<CancelGenerationButton status="cancelling" pending={false} onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    rerender(<CancelGenerationButton status="generating" pending onCancel={onCancel} />);
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
  });
});

describe("CancelledGenerationBanner", () => {
  it("says the run was cancelled and offers to finish it", () => {
    const onRegenerate = vi.fn();
    render(<CancelledGenerationBanner regenerating={false} onRegenerate={onRegenerate} />);
    expect(screen.getByRole("status")).toHaveTextContent(/generation was cancelled/i);
    expect(screen.getByRole("status")).toHaveTextContent(
      /reuses the finished sections whose inputs have not changed, where it can/i,
    );
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});

describe("DocumentationPage — cancel (#855)", () => {
  it("cancels from the list card without opening the document", async () => {
    setup({ ...base, status: "generating" });
    const card = await screen.findByTestId(`doc-card-${DOC_ID}`);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel generation" }));
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
    expect(cancelCalls()[0][1]).toMatchObject({ method: "POST" });
    // #980 — the header stops counting the job as soon as the server accepts.
    await waitFor(() => expect(dismissActiveJob).toHaveBeenCalledWith(DOC_ID));
    // Still on the list: the card's own click did not fire.
    expect(card).toBeInTheDocument();
    expect(screen.queryByText("Export PDF")).toBeNull();
  });

  it("cancels from the detail view", async () => {
    setup({ ...base, status: "generating" });
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    await screen.findByText("Export PDF");
    fireEvent.click(screen.getByRole("button", { name: "Cancel generation" }));
    await waitFor(() => expect(cancelCalls()).toHaveLength(1));
  });

  it("shows a cancelled document's banner and regenerates it", async () => {
    setup({
      ...base,
      status: "cancelled",
      content: "# BRD\n\n## Overview",
      errorMessage: "Generation was cancelled.",
    });
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    expect(await screen.findByText(/generation was cancelled/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel generation" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/projects/proj_test/docs/${DOC_ID}/regenerate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("#867 — a published document whose regenerate was cancelled shows its version, with no kept-sections banner", async () => {
    // What the server restores after cancelling a run over a published version.
    setup({
      ...base,
      status: "ready",
      content: "# BRD v1",
      errorMessage: null,
      versions: [{ version: 1 }],
    });
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
    expect(await screen.findByText("Export PDF")).toBeInTheDocument();
    expect(screen.queryByText(/generation was cancelled/i)).toBeNull();
    expect(screen.queryByText(/sections it finished are kept/i)).toBeNull();
  });

  it("offers no cancel for a finished document", async () => {
    setup({ ...base, status: "ready", content: "# Doc" });
    await screen.findByTestId(`doc-card-${DOC_ID}`);
    expect(screen.queryByRole("button", { name: "Cancel generation" })).toBeNull();
  });
});
