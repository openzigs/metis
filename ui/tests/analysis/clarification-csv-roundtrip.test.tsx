/**
 * Business Analyst CSV round-trip UI (export / import) on the Clarification
 * Dialog panel.
 *
 * Verifies the export button calls analysisApi.exportClarifyCsv then
 * triggerDownload(blob, filename); the import button wires a hidden file input
 * that calls analysisApi.importClarifyAnswers(projectId, analysisId, file),
 * surfaces the {applied,skipped,unmatched} summary, and fires onComplete; and
 * the error path surfaces the thrown message.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { analysisApi, triggerDownload } = vi.hoisted(() => ({
  analysisApi: {
    clarify: vi.fn(),
    exportClarifyCsv: vi.fn(),
    importClarifyAnswers: vi.fn(),
  },
  triggerDownload: vi.fn(),
}));

vi.mock("@/lib/analysis-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/analysis-api")>("@/lib/analysis-api");
  return { ...actual, analysisApi };
});
vi.mock("@/lib/plugins-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/plugins-api")>("@/lib/plugins-api");
  return { ...actual, triggerDownload };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ClarificationDialogPanel } from "@/components/analysis/ClarificationDialog";
import type { ClarificationStatePayload } from "@/lib/analysis-api";

function buildState(): ClarificationStatePayload {
  return {
    analysisId: "ana-1",
    currentRound: 1,
    maxRounds: 3,
    completed: false,
    escalatedToSonnet: false,
    resolvedAmbiguities: [],
    rounds: [
      {
        round: 1,
        answers: [],
        questions: [
          {
            id: "q-1",
            requirementId: "r1",
            ambiguityField: "retention",
            question: "How long should logs be retained?",
            context: "",
          },
        ],
      },
    ],
  };
}

function renderPanel(onComplete = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <ClarificationDialogPanel
        projectId="proj-1"
        analysisId="ana-1"
        state={buildState()}
        onComplete={onComplete}
      />
    </QueryClientProvider>,
  );
  return { onComplete };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ClarificationDialogPanel CSV round-trip", () => {
  it("renders the Export and Import action buttons", () => {
    renderPanel();
    expect(screen.getByRole("button", { name: /export questions/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import answers/i })).toBeInTheDocument();
  });

  it("export click calls exportClarifyCsv then triggerDownload", async () => {
    const blob = new Blob(["csv"], { type: "text/csv" });
    analysisApi.exportClarifyCsv.mockResolvedValue({ blob, filename: "questions.csv" });
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /export questions/i }));

    await waitFor(() => {
      expect(analysisApi.exportClarifyCsv).toHaveBeenCalledWith("proj-1", "ana-1");
    });
    await waitFor(() => {
      expect(triggerDownload).toHaveBeenCalledWith(blob, "questions.csv");
    });
  });

  it("selecting a CSV calls importClarifyAnswers, shows the summary, and fires onComplete", async () => {
    analysisApi.importClarifyAnswers.mockResolvedValue({
      applied: 2,
      skipped: 1,
      unmatched: ["q-bogus"],
    });
    const { onComplete } = renderPanel();

    const input = screen.getByTestId("clarify-import-input") as HTMLInputElement;
    const file = new File(["questionId,answer\nq-1,yes"], "answers.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(analysisApi.importClarifyAnswers).toHaveBeenCalledWith("proj-1", "ana-1", file);
    });
    await waitFor(() => {
      expect(screen.getByTestId("clarify-import-summary")).toHaveTextContent("2");
    });
    expect(screen.getByTestId("clarify-import-summary")).toHaveTextContent(/1/);
    expect(screen.getByTestId("clarify-import-summary")).toHaveTextContent("q-bogus");
    expect(onComplete).toHaveBeenCalled();
  });

  it("surfaces the thrown error message when import fails", async () => {
    const { toast } = await import("sonner");
    analysisApi.importClarifyAnswers.mockRejectedValue(new Error("bad csv headers"));
    renderPanel();

    const input = screen.getByTestId("clarify-import-input") as HTMLInputElement;
    const file = new File(["x"], "answers.csv", { type: "text/csv" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("bad csv headers");
    });
  });
});
