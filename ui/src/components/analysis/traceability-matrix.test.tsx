/**
 * Traceability matrix component tests — Issue #737 (Epic #726).
 *
 * Covers the rendered states (loading → populated), the coverage badge per row,
 * explicit empty cells, and that the CSV / markdown export buttons call the API
 * and trigger a download.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, within } from "@testing-library/react";
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

  it("suffixes each test with its relation when the resolver supplied one (#816)", async () => {
    getTraceability.mockResolvedValue({
      ...MATRIX,
      rows: [
        {
          ...MATRIX.rows[0],
          tests: [
            { filePath: "server/src/auth.test.ts", symbol: "login suite", relation: "exercises" },
            { filePath: "server/src/legacy.test.ts", symbol: "legacy" },
            {
              filePath: "internal/api/user_test.go",
              symbol: "TestCreateUserHandler",
              relation: "inferred-call",
            },
          ],
        },
      ],
    });
    renderMatrix();
    const row = await screen.findByTestId("traceability-row-req-1");
    const [withRelation, bare, inferred] = within(row).getAllByTestId("traceability-matrix-test");
    // #1137 — each test row names the test as well as its file.
    expect(withRelation).toHaveTextContent(
      "login suite in server/src/auth.test.ts · Calls the code",
    );
    expect(withRelation).toHaveAttribute(
      "title",
      "Calls the code: This test calls the code mapped to this requirement.",
    );
    // #1034 — a call bound by name after ingest says so.
    expect(inferred).toHaveTextContent(
      "TestCreateUserHandler in internal/api/user_test.go · Inferred call",
    );
    // A pre-#815 link with no relation renders no suffix.
    expect(bare).toHaveTextContent(/^legacy in server\/src\/legacy\.test\.ts$/);
    expect(bare).not.toHaveAttribute("title");
  });

  it("#1137 — strips the file prefix from a qualified test symbol, and shows a file-only hit once", async () => {
    getTraceability.mockResolvedValue({
      ...MATRIX,
      rows: [
        {
          ...MATRIX.rows[0],
          tests: [
            {
              filePath: "client/client_test.go",
              symbol: "client/client_test.go::TestMarkAllAsRead",
              relation: "exercises",
            },
            { filePath: "e2e/flow.spec.ts", symbol: "e2e/flow.spec.ts", relation: "direct" },
          ],
        },
      ],
    });
    renderMatrix();
    const row = await screen.findByTestId("traceability-row-req-1");
    const [named, fileOnly] = within(row).getAllByTestId("traceability-matrix-test");
    expect(named).toHaveTextContent(/^TestMarkAllAsRead in client\/client_test\.go · /);
    expect(fileOnly).toHaveTextContent(/^e2e\/flow\.spec\.ts · /);
  });

  it("#1137 — pages a long matrix, 25 requirements at a time", async () => {
    const rows = Array.from({ length: 33 }, (_, i) => ({
      ...MATRIX.rows[1]!,
      requirementId: `req-${i}`,
      title: `Requirement ${i}`,
    }));
    getTraceability.mockResolvedValue({ ...MATRIX, rows });
    renderMatrix();
    await screen.findByTestId("traceability-row-req-0");
    expect(screen.getAllByTestId(/^traceability-row-/)).toHaveLength(25);
    expect(screen.getByTestId("traceability-matrix-pager-range")).toHaveTextContent(
      "Showing 1–25 of 33 requirements",
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getAllByTestId(/^traceability-row-/)).toHaveLength(8);
    expect(screen.getByTestId("traceability-row-req-32")).toBeInTheDocument();
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
