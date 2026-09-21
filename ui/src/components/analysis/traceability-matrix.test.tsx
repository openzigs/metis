/**
 * Traceability matrix component tests — Issue #737 (Epic #726).
 *
 * Covers the rendered states (loading → populated), the coverage badge per row,
 * explicit empty cells, and that the CSV / markdown export buttons call the API
 * and trigger a download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TraceabilityMatrix as TMatrix } from "@metis/shared";

const getTraceability = vi.fn();
const exportTraceability = vi.fn();
vi.mock("@/lib/analysis-api", () => ({
  analysisApi: {
    getTraceability: (...args: unknown[]) => getTraceability(...args),
    exportTraceability: (...args: unknown[]) => exportTraceability(...args),
  },
}));

const triggerDownload = vi.fn();
vi.mock("@/lib/plugins-api", () => ({
  triggerDownload: (...args: unknown[]) => triggerDownload(...args),
}));

import { TraceabilityMatrix } from "./traceability-matrix";

const MATRIX: TMatrix = {
  analysisId: "an-1",
  projectId: "proj-1",
  testsDetection: "heuristic",
  rows: [
    {
      requirementId: "req-1",
      title: "Users can log in",
      coverage: "grounded_in_code",
      verdict: "implemented",
      findings: [{ id: "f-1", title: "Login handler present", severity: "high" }],
      codeLocations: [
        { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, source: "citation" },
      ],
      tests: [{ filePath: "server/src/auth.test.ts", symbol: "login suite" }],
    },
    {
      requirementId: "req-2",
      title: "Password reset",
      coverage: "no_evidence",
      // #773 — a no-evidence row is NOT a gap; the verdict column says so.
      verdict: "could-not-verify",
      findings: [],
      codeLocations: [],
      tests: [],
    },
  ],
};

function renderMatrix(enabled = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TraceabilityMatrix projectId="proj-1" analysisId="an-1" enabled={enabled} />
    </QueryClientProvider>,
  );
}

describe("TraceabilityMatrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTraceability.mockResolvedValue(MATRIX);
    exportTraceability.mockResolvedValue({ blob: new Blob(["x"]), filename: "m.csv" });
  });
  afterEach(() => cleanup());

  it("renders nothing when disabled and never fetches", () => {
    renderMatrix(false);
    expect(screen.queryByTestId("traceability-matrix")).toBeNull();
    expect(getTraceability).not.toHaveBeenCalled();
  });

  it("renders a row per requirement with coverage badges", async () => {
    renderMatrix();
    await waitFor(() => expect(screen.getByTestId("traceability-row-req-1")).toBeInTheDocument());
    expect(screen.getByText("Users can log in")).toBeInTheDocument();
    expect(screen.getByText("Login handler present")).toBeInTheDocument();
    expect(screen.getByText("server/src/auth.ts:10-20")).toBeInTheDocument();
    // Coverage badges rendered per row (grounded_in_code + no_evidence).
    expect(screen.getByTestId("coverage-badge-grounded_in_code")).toBeInTheDocument();
    expect(screen.getByTestId("coverage-badge-no_evidence")).toBeInTheDocument();
  });

  it("shows explicit empty cells for a requirement with no trace", async () => {
    renderMatrix();
    const row = await screen.findByTestId("traceability-row-req-2");
    expect(row).toHaveTextContent("none");
    expect(row).toHaveTextContent("none detected");
  });

  it("exports CSV via the API and triggers a download", async () => {
    renderMatrix();
    // Wait for the data (buttons are disabled until rows load).
    await screen.findByTestId("traceability-row-req-1");
    fireEvent.click(screen.getByTestId("traceability-export-csv"));
    await waitFor(() => expect(exportTraceability).toHaveBeenCalledWith("proj-1", "an-1", "csv"));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalled());
  });

  it("exports markdown via the API and triggers a download", async () => {
    exportTraceability.mockResolvedValue({ blob: new Blob(["x"]), filename: "m.md" });
    renderMatrix();
    await screen.findByTestId("traceability-row-req-1");
    fireEvent.click(screen.getByTestId("traceability-export-md"));
    await waitFor(() => expect(exportTraceability).toHaveBeenCalledWith("proj-1", "an-1", "md"));
    await waitFor(() => expect(triggerDownload).toHaveBeenCalled());
  });

  it("renders an empty-state message when there are no requirements", async () => {
    getTraceability.mockResolvedValue({ ...MATRIX, rows: [] });
    renderMatrix();
    await waitFor(() => expect(screen.getByText(/No requirements to trace/i)).toBeInTheDocument());
    // Export buttons are disabled with no rows.
    expect(screen.getByTestId("traceability-export-csv")).toBeDisabled();
  });

  it("surfaces a load error", async () => {
    getTraceability.mockRejectedValue(new Error("boom"));
    renderMatrix();
    await waitFor(() =>
      expect(screen.getByText(/Could not load the traceability matrix/i)).toBeInTheDocument(),
    );
  });
});
