/**
 * Issue #1007 — `/runs` and a run's page show the ledger's tokens, named with
 * and without cache; a run that is going never reads "0 tok"; and chat turns,
 * which are not runs, are listed from the usage ledger with their exact cost.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/runs-api", () => ({
  runsApi: {
    list: vi.fn(),
    get: vi.fn(),
    replay: vi.fn(),
    chatTurns: vi.fn(),
    sandboxSessions: vi.fn(async () => ({ runId: "r", sessions: [] })),
  },
  agentsMdApi: { getMarkdown: vi.fn(), preview: vi.fn() },
}));

vi.mock("next/navigation", async () => {
  const actual = await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useParams: vi.fn(() => ({ id: "run_1" })),
    useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() })),
    usePathname: vi.fn(() => "/runs"),
    useSearchParams: vi.fn(() => new URLSearchParams()),
  };
});

import { runsApi } from "@/lib/runs-api";
import RunsPage from "@/app/(authed)/runs/page";
import RunDetailPage from "@/app/(authed)/runs/[id]/page";
import { formatLedgerTokens, formatTokens, runTokensLabel } from "@/lib/run-tokens";

const list = vi.mocked(runsApi.list);
const get = vi.mocked(runsApi.get);
const chatTurns = vi.mocked(runsApi.chatTurns);

function run(over: Record<string, unknown> = {}) {
  return {
    id: "run_1",
    sessionId: "an-1",
    projectId: "p1",
    kind: "analysis",
    status: "completed",
    startedAt: "2026-10-09T10:00:00.000Z",
    completedAt: "2026-10-09T10:30:00.000Z",
    latencyMs: 1_800_000,
    totalTokens: 439_244,
    costCents: 34,
    costUsd: 0.3352,
    tokens: { withoutCache: 457_901, withCache: 545_197 },
    stepCount: 4,
    ...over,
  };
}

function turn(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    sessionId: "chat-a",
    projectId: "p1",
    step: "chat",
    provider: "anthropic",
    model: "deepseek-flash",
    createdAt: "2026-10-09T11:00:00.000Z",
    requests: 3,
    tokens: { withoutCache: 21_629, withCache: 86_781 },
    costUsd: 0.01115,
    ...over,
  };
}

function renderRuns() {
  const Wrapper = makeWrapper({});
  render(
    <Wrapper>
      <RunsPage />
    </Wrapper>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue({ items: [] } as never);
  chatTurns.mockResolvedValue({ items: [] } as never);
});

describe("run-tokens labels (#1007)", () => {
  it("names both ledger figures", () => {
    expect(formatLedgerTokens({ withoutCache: 457_901, withCache: 545_197 })).toBe(
      "457.9k tok without cache · 545.2k with cache",
    );
    expect(formatLedgerTokens({ withoutCache: 999, withCache: 2_340_000 })).toBe(
      "999 tok without cache · 2.34M with cache",
    );
    expect(formatTokens(1_000)).toBe("1.0k");
  });

  it("prefers the ledger, then in progress, then the stored total said to be that", () => {
    const tokens = { withoutCache: 10, withCache: 12 };
    expect(runTokensLabel({ tokens, storedTotal: 99, status: "completed" })).toBe(
      "10 tok without cache · 12 with cache",
    );
    // The ledger's running total wins over "in progress" once it has a row.
    expect(runTokensLabel({ tokens, storedTotal: 0, status: "running" })).toBe(
      "10 tok without cache · 12 with cache",
    );
    const none = { withoutCache: 0, withCache: 0 };
    expect(runTokensLabel({ tokens: none, storedTotal: 0, status: "running" })).toBe("in progress");
    expect(runTokensLabel({ tokens: null, storedTotal: 0, status: "pending" })).toBe("in progress");
    expect(runTokensLabel({ tokens: none, storedTotal: 240_792, status: "completed" })).toBe(
      "240.8k tok recorded at finish (not in the ledger)",
    );
    expect(runTokensLabel({ tokens: null, storedTotal: null, status: "cancelled" })).toBe("0 tok");
    expect(runTokensLabel({})).toBe("0 tok");
  });
});

describe("/runs token figures (#1007)", () => {
  it("shows a run's ledger tokens with and without cache, not the total stored at finish", async () => {
    list.mockResolvedValue({ items: [run()] } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-table");
    expect(table).toHaveTextContent("457.9k tok without cache · 545.2k with cache");
    expect(table).toHaveTextContent("Tokens (usage ledger)");
    expect(table).not.toHaveTextContent("439244");
    expect(table).not.toHaveTextContent("439.2k");
  });

  it("a run that is going shows its ledger total so far, or in progress — never 0 tok", async () => {
    list.mockResolvedValue({
      items: [
        run({
          id: "going",
          status: "running",
          totalTokens: 0,
          tokens: { withoutCache: 1_100, withCache: 5_100 },
        }),
        run({
          id: "quiet",
          status: "running",
          totalTokens: 0,
          tokens: { withoutCache: 0, withCache: 0 },
        }),
      ],
    } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-table");
    expect(table).toHaveTextContent("1.1k tok without cache · 5.1k with cache");
    expect(table).toHaveTextContent("in progress");
    expect(table).not.toHaveTextContent("0 tok");
  });

  it("says a stored total is that when the ledger could not be read", async () => {
    list.mockResolvedValue({ items: [run({ tokens: null, totalTokens: 5_000 })] } as never);
    renderRuns();
    expect(await screen.findByTestId("runs-table")).toHaveTextContent(
      "5.0k tok recorded at finish (not in the ledger)",
    );
  });
});

describe("/runs chat turns (#1007)", () => {
  it("lists chat turns from the ledger with their tokens and exact sub-cent cost", async () => {
    chatTurns.mockResolvedValue({
      items: [
        turn(),
        turn({ id: "t2", step: "chat-estimated", requests: 1, costUsd: null }),
        turn({ id: "t3", step: "chat-failed", costUsd: 0.003 }),
      ],
    } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-chat-turns-table");
    expect(table).toHaveTextContent("chat-a");
    expect(table).toHaveTextContent("21.6k tok without cache · 86.8k with cache");
    // $0.01115 is shown to four places, not as "$0.01" or "—".
    expect(table).toHaveTextContent("$0.0112");
    expect(table).toHaveTextContent("$0.0030");
    expect(table).toHaveTextContent("deepseek-flash (estimated)");
    expect(table).toHaveTextContent("deepseek-flash (failed turn)");
    expect(table).toHaveTextContent("unpriced");
    expect(within(table).getAllByText("3").length).toBeGreaterThan(0);
    // Says what the table is, so nobody looks for a chat turn among the runs.
    expect(screen.getByTestId("runs-chat-turns")).toHaveTextContent(
      "A chat turn is not a run: it has no timeline to replay.",
    );
  });

  it("reads chat turns under the same filters as the runs", async () => {
    renderRuns();
    await waitFor(() => expect(chatTurns).toHaveBeenCalledWith({}));
    fireEvent.change(screen.getByLabelText("Project ID"), { target: { value: "p1" } });
    fireEvent.change(screen.getByLabelText("Session ID"), { target: { value: "chat-a" } });
    await waitFor(() =>
      expect(chatTurns).toHaveBeenLastCalledWith({ projectId: "p1", sessionId: "chat-a" }),
    );
    expect(list).toHaveBeenLastCalledWith({ projectId: "p1", sessionId: "chat-a" });
  });

  it("says so when no chat turn matches", async () => {
    renderRuns();
    expect(await screen.findByTestId("runs-chat-turns-empty")).toHaveTextContent(
      "No chat turns match these filters.",
    );
  });

  it("reports a failed read without hiding the runs", async () => {
    list.mockResolvedValue({ items: [run()] } as never);
    chatTurns.mockRejectedValue(new Error("ledger down"));
    renderRuns();
    expect(await screen.findByText(/Failed to load chat turns: ledger down/)).toBeInTheDocument();
    expect(await screen.findByTestId("runs-table")).toBeInTheDocument();
  });
});

describe("a run's page (#1007)", () => {
  const detail = (over: Record<string, unknown>) => {
    const { stepCount: _stepCount, ...rest } = run(over);
    return { run: rest, steps: [] };
  };
  function renderDetail() {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <RunDetailPage />
      </Wrapper>,
    );
  }

  it("shows the same ledger figures as the list", async () => {
    get.mockResolvedValue(detail({}) as never);
    renderDetail();
    expect(await screen.findByTestId("run-tokens")).toHaveTextContent(
      "457.9k tok without cache · 545.2k with cache",
    );
    expect(screen.getByText("Tokens (usage ledger)")).toBeInTheDocument();
  });

  it("reads in progress for a run that is going with no ledger row", async () => {
    get.mockResolvedValue(
      detail({
        status: "running",
        totalTokens: 0,
        tokens: { withoutCache: 0, withCache: 0 },
      }) as never,
    );
    renderDetail();
    expect(await screen.findByTestId("run-tokens")).toHaveTextContent("in progress");
  });
});
