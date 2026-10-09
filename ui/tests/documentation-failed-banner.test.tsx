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
  generationStopCause,
  generationStopStage,
  failedSections,
  isPartialGeneration,
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

const STOP = {
  kind: "section-failed",
  section: "Document",
  severity: "error",
  stage: "assembly",
  errorClass: "TypeError",
  message:
    'Section "Document" could not be generated: generation stopped after the sections were written, while assembling the document (TypeError).',
};

describe("#782 — why a generation stopped is shown, not left in the server log", () => {
  it("reads the cause from the warning that carries a stage, and only that one", () => {
    const other = {
      kind: "section-ungrounded",
      section: "Rules",
      severity: "warning",
      message: "x",
    };
    expect(generationStopCause([other, STOP])).toBe(STOP.message);
    expect(generationStopCause([other])).toBeNull();
    expect(generationStopCause(null)).toBeNull();
  });

  it("is a partial generation only when degraded, unpublished and stopped", () => {
    expect(isPartialGeneration({ status: "degraded", versions: [], warnings: [STOP] })).toBe(true);
    expect(isPartialGeneration({ status: "degraded", warnings: [STOP] })).toBe(true);
    expect(
      isPartialGeneration({
        status: "degraded",
        versions: [{ id: "v", version: 1, diffSummary: null, createdAt: "" }],
        warnings: [STOP],
      }),
    ).toBe(false);
    expect(isPartialGeneration({ status: "degraded", versions: [], warnings: [] })).toBe(false);
    expect(isPartialGeneration({ status: "failed", versions: [], warnings: [STOP] })).toBe(false);
  });

  it("FailedGenerationBanner shows the cause and says finished sections are reused", () => {
    render(
      <FailedGenerationBanner
        interrupted={false}
        cause={STOP.message}
        stage="assembly"
        onRegenerate={vi.fn()}
        regenerating={false}
      />,
    );
    expect(screen.getByTestId("generation-stop-cause")).toHaveTextContent("(TypeError)");
    expect(screen.getByRole("alert")).toHaveTextContent(/reuses every section/i);
    expect(screen.getByRole("alert")).not.toHaveTextContent(/server logs/i);
  });

  it("makes no reuse claim when it stopped before any section could finish", () => {
    const early = { ...STOP, stage: "facts", message: "Stopped while extracting facts (Error)." };
    render(
      <FailedGenerationBanner
        interrupted={false}
        cause={early.message}
        stage={early.stage}
        onRegenerate={vi.fn()}
        regenerating={false}
      />,
    );
    expect(screen.getByTestId("generation-stop-cause")).toHaveTextContent("extracting facts");
    expect(screen.getByRole("alert")).not.toHaveTextContent(/reuses/i);
  });

  it("reads the stage from the warning that carries one", () => {
    expect(generationStopStage([STOP])).toBe("assembly");
    expect(generationStopStage([])).toBeNull();
    expect(generationStopStage(null)).toBeNull();
  });

  describe("on the page", () => {
    const DOC_ID = "doc_2";
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
    const base = {
      id: DOC_ID,
      title: "BRD",
      scope: "full",
      autoUpdate: false,
      generatedAt: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    };

    it("a failed document shows its recorded cause", async () => {
      setup({ ...base, status: "failed", content: "", warnings: [STOP], versions: [] });
      fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
      expect(await screen.findByTestId("generation-stop-cause")).toHaveTextContent(
        "while assembling the document",
      );
    });

    it("a partial document shows its sections and regenerates to finish", async () => {
      setup({
        ...base,
        status: "degraded",
        content: "# BRD\n\n## Overview",
        warnings: [STOP],
        versions: [],
      });
      fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
      expect(await screen.findByText(/generation stopped before it finished/i)).toBeInTheDocument();
      expect(await screen.findByTestId("markdown-previewer")).toHaveTextContent("## Overview");
      fireEvent.click(screen.getByRole("button", { name: /^regenerate$/i }));
      await waitFor(() =>
        expect(mockApiFetch).toHaveBeenCalledWith(
          `/projects/proj_test/docs/${DOC_ID}/regenerate`,
          expect.objectContaining({ method: "POST" }),
        ),
      );
    });

    it("a published degraded document offers no partial-regenerate", async () => {
      setup({
        ...base,
        status: "degraded",
        content: "# BRD",
        warnings: [
          { kind: "section-ungrounded", section: "Rules", severity: "warning", message: "x" },
        ],
        versions: [{ id: "v1", version: 1, diffSummary: null, createdAt: base.createdAt }],
      });
      fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));
      await screen.findByTestId("markdown-previewer");
      expect(screen.queryByText(/generation stopped before it finished/i)).toBeNull();
    });
  });
});

describe("#942 — a published document with a failed section can regenerate it", () => {
  const FAILED = {
    kind: "section-failed",
    section: "Overview, Context & Layers",
    severity: "error",
    detailSafe: true,
    message:
      'Section "Overview, Context & Layers" could not be generated: it failed with an unrecognised error (SyntaxError); the full error is in the server log.',
  };
  const V1 = [{ id: "v1", version: 1, diffSummary: null, createdAt: "2026-10-08T00:00:00.000Z" }];

  it("names the failed sections of a published degraded document, never a stop cause", () => {
    expect(failedSections({ status: "degraded", versions: V1, warnings: [FAILED] })).toEqual([
      FAILED,
    ]);
    // A whole-run stop cause carries a stage; that is the partial banner's job.
    expect(failedSections({ status: "degraded", versions: V1, warnings: [STOP] })).toEqual([]);
    // Unpublished: the partial-generation banner already offers the regenerate.
    expect(failedSections({ status: "degraded", versions: [], warnings: [FAILED] })).toEqual([]);
    expect(failedSections({ status: "ready", versions: V1, warnings: [FAILED] })).toEqual([]);
    expect(failedSections({ status: "degraded", versions: V1, warnings: null })).toEqual([]);
  });

  it("shows the reason and POSTs /regenerate from the page", async () => {
    const DOC_ID = "doc_942";
    const doc = {
      id: DOC_ID,
      title: "Architecture",
      scope: "full",
      autoUpdate: false,
      generatedAt: null,
      createdAt: "2026-10-08T00:00:00.000Z",
      status: "degraded",
      content: "# Architecture",
      warnings: [FAILED],
      versions: V1,
    };
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
    fireEvent.click(await screen.findByTestId(`doc-card-${DOC_ID}`));

    const banner = await screen.findByTestId("failed-sections-banner");
    expect(banner).toHaveTextContent("Overview, Context & Layers");
    expect(banner).toHaveTextContent("(SyntaxError)");
    expect(banner).toHaveTextContent(/reuses the finished sections/i);
    fireEvent.click(screen.getByRole("button", { name: /regenerate failed section/i }));
    await waitFor(() =>
      expect(mockApiFetch).toHaveBeenCalledWith(
        `/projects/proj_test/docs/${DOC_ID}/regenerate`,
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });
});
