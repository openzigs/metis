/**
 * #718 — a failed scan used to show only "status failed · 0/0 symbols" and
 * "No findings yet."; the server's `errorMessage` was never rendered. A scan
 * that completed with skipped symbols carries the reason there too.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: vi.fn(() => ({ id: "proj-1", scanId: "scan-1" })),
}));

vi.mock("@/lib/scanner-api", () => ({
  scannerApi: {
    getScan: vi.fn(),
    listFindings: vi.fn(async () => []),
  },
}));

import { scannerApi } from "@/lib/scanner-api";
import ScanTriagePage from "@/app/(authed)/projects/[id]/scans/[scanId]/page";

function scan(over: Record<string, unknown> = {}) {
  return {
    id: "scan-1",
    projectId: "proj-1",
    repoConnectionId: "repo-1",
    commitSha: "703fe826aaaa",
    status: "failed",
    mode: "both",
    startedAt: null,
    completedAt: null,
    totalSymbols: 3533,
    scannedSymbols: 0,
    totalTokens: 16240,
    costCents: 0,
    budgetCapTokens: 2_000_000,
    errorMessage: null,
    createdAt: "2026-10-02T16:34:25Z",
    ...over,
  };
}

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ScanTriagePage />
    </Wrapper>,
  );
}

describe("Scan triage page — errorMessage (#718)", () => {
  it("renders a failed scan's error as an alert", async () => {
    vi.mocked(scannerApi.getScan).mockResolvedValue(
      scan({ errorMessage: "no JSON object/array found in model output" }) as never,
    );
    renderPage();
    const alert = await screen.findByTestId("scanner-triage-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent("Scan failed");
    expect(alert).toHaveTextContent("no JSON object/array found in model output");
  });

  it("renders a completed scan's skipped-symbol note as a non-failure notice", async () => {
    vi.mocked(scannerApi.getScan).mockResolvedValue(
      scan({ status: "completed", errorMessage: "5 of 3533 symbols skipped" }) as never,
    );
    renderPage();
    const note = await screen.findByTestId("scanner-triage-error");
    expect(note).toHaveAttribute("role", "status");
    expect(note).not.toHaveTextContent("Scan failed");
    expect(note).toHaveTextContent("5 of 3533 symbols skipped");
  });

  it("renders nothing when there is no error", async () => {
    vi.mocked(scannerApi.getScan).mockResolvedValue(scan({ status: "completed" }) as never);
    renderPage();
    await screen.findByTestId("scanner-triage-meta");
    expect(screen.queryByTestId("scanner-triage-error")).toBeNull();
  });
});
