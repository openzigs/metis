/**
 * Issue #1220 — the "Diverged from source" badge on an imported requirement's
 * card, its two answers, the History line that records them, and the import
 * run's summary counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementSourceDivergence } from "@metis/shared";

const resolveDivergence = vi.fn();
vi.mock("@/lib/collaboration-api", () => ({
  requirementSourceApi: {
    resolveDivergence: (...a: unknown[]) => resolveDivergence(...a),
  },
}));
const list = vi.fn();
vi.mock("@/lib/history-api", () => ({
  historyApi: { list: (...a: unknown[]) => list(...a), restore: vi.fn(), export: vi.fn() },
}));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { role: "reader" } }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

import { SourceDivergenceNotice } from "@/components/requirements/SourceDivergenceNotice";
import { RequirementHistoryTab } from "@/components/requirements/RequirementHistoryTab";
import { importRunSummary } from "@/lib/import-run-summary";

const local = {
  title: "Export orders",
  body: "Refined by the analyst",
  type: "feature",
  priority: "high",
  labels: ["export"],
};
const divergence: RequirementSourceDivergence = {
  sourceFingerprint: "v1:abc",
  detectedAt: "2026-10-16T10:00:00.000Z",
  source: { ...local, body: "Changed upstream", priority: "medium" },
};
const KEY = ["analyses", "detail", "ana-1"];

function renderNotice(div: RequirementSourceDivergence | null = divergence) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <SourceDivergenceNotice
        requirementId="req-1"
        version={3}
        divergence={div}
        local={local}
        invalidateKeys={[KEY]}
      />
    </QueryClientProvider>,
  );
  return { invalidate };
}

describe("SourceDivergenceNotice", () => {
  beforeEach(() => {
    resolveDivergence.mockReset();
    toast.success.mockReset();
    toast.error.mockReset();
  });

  it("renders nothing for a requirement that is not diverged", () => {
    renderNotice(null);
    expect(screen.queryByText("Diverged from source")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Keep mine" })).not.toBeInTheDocument();
  });

  it("shows the badge and compares only the fields that differ", () => {
    renderNotice();
    expect(screen.getByText("Diverged from source")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Compare" }));

    const table = screen.getByRole("table", { name: /Your version and the source's/ });
    expect(table).toHaveTextContent("Refined by the analyst");
    expect(table).toHaveTextContent("Changed upstream");
    expect(screen.getByRole("rowheader", { name: "body" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "priority" })).toBeInTheDocument();
    expect(screen.queryByRole("rowheader", { name: "title" })).not.toBeInTheDocument();
  });

  it("Take the source version sends the fingerprint and the version shown, then refetches", async () => {
    resolveDivergence.mockResolvedValue({
      id: "req-1",
      choice: "source",
      version: 4,
      changed: true,
    });
    const { invalidate } = renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Take the source version" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Took the source version"));
    expect(resolveDivergence).toHaveBeenCalledWith("req-1", {
      choice: "source",
      sourceFingerprint: "v1:abc",
      version: 3,
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("Keep mine sends the fingerprint without a version, then refetches", async () => {
    resolveDivergence.mockResolvedValue({
      id: "req-1",
      choice: "local",
      version: 3,
      changed: false,
    });
    const { invalidate } = renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Kept your version"));
    expect(resolveDivergence).toHaveBeenCalledWith("req-1", {
      choice: "local",
      sourceFingerprint: "v1:abc",
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });

  it("a refused answer (the source moved again) reports the error and refetches", async () => {
    resolveDivergence.mockRejectedValue(new Error("The source changed again"));
    const { invalidate } = renderNotice();

    fireEvent.click(screen.getByRole("button", { name: "Keep mine" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: KEY });
  });
});

describe("RequirementHistoryTab — the source decision", () => {
  const page = (sourceDecision: unknown) => ({
    versions: [],
    total: 0,
    page: 1,
    pageSize: 20,
    currentVersion: 1,
    sourceDecision,
  });

  it("records Keep mine, which has no version row", async () => {
    list.mockResolvedValue(
      page({ choice: "local", actorId: "u1", at: "2026-10-16T10:00:00.000Z" }),
    );
    render(<RequirementHistoryTab requirementId="req-1" />);
    expect(await screen.findByTestId("history-source-decision")).toHaveTextContent(
      /Kept the local version over a change in the import source/,
    );
  });

  it("records Take the source version", async () => {
    list.mockResolvedValue(
      page({ choice: "source", actorId: "u1", at: "2026-10-16T10:00:00.000Z" }),
    );
    render(<RequirementHistoryTab requirementId="req-1" />);
    expect(await screen.findByTestId("history-source-decision")).toHaveTextContent(
      /Took the import source's version over local edits/,
    );
  });

  it("says nothing when the analyst was never asked", async () => {
    list.mockResolvedValue(page(null));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await screen.findByText("No version history yet.");
    expect(screen.queryByTestId("history-source-decision")).not.toBeInTheDocument();
  });
});

describe("importRunSummary", () => {
  it("names new and updated, and kept edits and divergences only when there are any", () => {
    expect(importRunSummary({ createdCount: 5, updatedCount: 0 })).toBe("5 new · 0 updated");
    expect(
      importRunSummary({ createdCount: 0, updatedCount: 2, keptLocalCount: 1, divergedCount: 3 }),
    ).toBe("0 new · 2 updated · kept 1 local edit · 3 diverged from source");
    expect(
      importRunSummary({ createdCount: 0, updatedCount: 0, keptLocalCount: 2, divergedCount: 0 }),
    ).toBe("0 new · 0 updated · kept 2 local edits");
  });
});
