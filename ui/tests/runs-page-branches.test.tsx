/**
 * Issue #121 extended — additional runs page and vault page branch coverage.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ─── RunsPage additional branches ────────────────────────────────────────────

vi.mock("@/lib/runs-api", () => ({
  runsApi: { list: vi.fn(), get: vi.fn(), replay: vi.fn() },
  agentsMdApi: { getMarkdown: vi.fn(), preview: vi.fn() },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "run_test" })),
    useRouter: vi.fn(() => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      prefetch: vi.fn(),
    })),
    usePathname: vi.fn(() => "/"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

import { runsApi } from "@/lib/runs-api";
import RunsPage from "@/app/(authed)/runs/page";

const listMock = runsApi.list as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue({ items: [] });
});

function makeRun(over: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    sessionId: "s1",
    projectId: "p1",
    kind: "analysis",
    status: "completed",
    startedAt: "2026-04-01T00:00:00.000Z",
    completedAt: "2026-04-01T00:00:01.000Z",
    latencyMs: 1234,
    totalTokens: 99,
    costCents: 12,
    stepCount: 4,
    ...over,
  };
}

describe("RunsPage — additional branch coverage", () => {
  it("shows error state when runs API fails", async () => {
    listMock.mockRejectedValueOnce(new Error("Server error"));
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText(/Failed to load runs/i)).toBeInTheDocument());
  });

  it("renders failed run with red status", async () => {
    listMock.mockResolvedValueOnce({ items: [makeRun({ id: "r1", status: "failed" })] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("failed")).toBeInTheDocument());
  });

  it("renders cancelled run with amber status", async () => {
    listMock.mockResolvedValueOnce({ items: [makeRun({ id: "r1", status: "cancelled" })] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("cancelled")).toBeInTheDocument());
  });

  it("renders running run (default status class)", async () => {
    listMock.mockResolvedValueOnce({ items: [makeRun({ id: "r1", status: "running" })] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByText("running")).toBeInTheDocument());
  });

  it("date filter propagates to query", async () => {
    listMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-01-01" } });
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ from: "2026-01-01" })),
    );
  });

  it("to date filter propagates to query", async () => {
    listMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-06-01" } });
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ to: "2026-06-01" })),
    );
  });

  it("session filter propagates to query", async () => {
    listMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Session ID"), { target: { value: "sess_abc" } });
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess_abc" })),
    );
  });

  it("renders '—' for unattributed cost (costCents=0, tokens>0)", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeRun({ id: "r1", costCents: 0, totalTokens: 5000 })],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("runs-table")).toBeInTheDocument());
    // Tokens are rendered, but cost is unattributed so no "$0.0000" misleading value.
    expect(screen.getByText("5000")).toBeInTheDocument();
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
    expect(screen.queryAllByText("—").length).toBeGreaterThan(0);
  });

  it("renders a formatted dollar value when costCents > 0", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeRun({ id: "r1", costCents: 1234, totalTokens: 5000 })],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("runs-table")).toBeInTheDocument());
    expect(screen.getByText("$12.3400")).toBeInTheDocument();
  });

  it("renders run with null latencyMs (— shown)", async () => {
    listMock.mockResolvedValueOnce({
      items: [makeRun({ id: "r1", latencyMs: null, completedAt: null })],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("runs-table")).toBeInTheDocument());
    // Null latency renders as "—"
    expect(screen.queryAllByText("—").length).toBeGreaterThan(0);
  });
});
