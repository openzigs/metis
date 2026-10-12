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
import {
  formatLedgerTokens,
  formatTokens,
  runTokensLabel,
  tokensAfterRunNote,
} from "@/lib/run-tokens";
import { formatRunCost } from "@/lib/run-cost";

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
    expect(runTokensLabel({ tokens: none, storedTotal: null, status: "cancelled" })).toBe("0 tok");
  });

  it("tells a ledger that could not be read from one with no rows (review of #1112)", () => {
    const none = { withoutCache: 0, withCache: 0 };
    // Read, and empty.
    expect(runTokensLabel({ tokens: none, storedTotal: 5_000, status: "completed" })).toBe(
      "5.0k tok recorded at finish (not in the ledger)",
    );
    // Not read: `null` from the API, or absent.
    expect(runTokensLabel({ tokens: null, storedTotal: 5_000, status: "completed" })).toBe(
      "5.0k tok recorded at finish (ledger unavailable)",
    );
    expect(runTokensLabel({ storedTotal: 5_000, status: "failed" })).toBe(
      "5.0k tok recorded at finish (ledger unavailable)",
    );
    // Nothing stored either: say the ledger is why there is no figure, not "0 tok".
    expect(runTokensLabel({ tokens: null, storedTotal: null, status: "cancelled" })).toBe(
      "ledger unavailable",
    );
    expect(runTokensLabel({})).toBe("ledger unavailable");
    // A run that is going is "in progress" either way.
    expect(runTokensLabel({ tokens: null, storedTotal: 0, status: "running" })).toBe("in progress");
  });

  it("notes the tokens recorded after a run finished, only when there are any", () => {
    expect(tokensAfterRunNote({ withoutCache: 339_834, withCache: 393_216 })).toBe(
      "includes 339.8k tok without cache · 393.2k with cache recorded after the run finished",
    );
    expect(tokensAfterRunNote({ withoutCache: 0, withCache: 0 })).toBeNull();
    expect(tokensAfterRunNote(null)).toBeNull();
    expect(tokensAfterRunNote(undefined)).toBeNull();
  });
});

describe("formatRunCost: the stored cost, unpriced tokens named (review of #1112)", () => {
  it("shows the priced cost and the unpriced tokens side by side", () => {
    expect(formatRunCost({ costCents: 150, costUsd: 1.5, unpricedTokens: 100_000 })).toBe(
      "$1.5000 + 100.0k unpriced tok",
    );
    expect(formatRunCost({ costCents: 0, costUsd: 0, unpricedTokens: 100_000 })).toBe(
      "100.0k unpriced tok",
    );
    expect(formatRunCost({ costCents: null, costUsd: null, unpricedTokens: 55 })).toBe(
      "55 unpriced tok",
    );
    expect(formatRunCost({ costCents: 150, costUsd: 1.5, unpricedTokens: 0 })).toBe("$1.5000");
    expect(formatRunCost({ costCents: 150, costUsd: 1.5, unpricedTokens: null })).toBe("$1.5000");
    expect(formatRunCost({ costCents: 0, costUsd: 0, unpricedTokens: 0 })).toBe("—");
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

  it("says a stored total is that, and that the ledger was unavailable, when it could not be read", async () => {
    list.mockResolvedValue({ items: [run({ tokens: null, totalTokens: 5_000 })] } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-table");
    expect(table).toHaveTextContent("5.0k tok recorded at finish (ledger unavailable)");
    expect(table).not.toHaveTextContent("not in the ledger");
  });

  it("says a stored total is not in the ledger when the ledger was read and has no row", async () => {
    list.mockResolvedValue({
      items: [run({ tokens: { withoutCache: 0, withCache: 0 }, totalTokens: 240_792 })],
    } as never);
    renderRuns();
    expect(await screen.findByTestId("runs-table")).toHaveTextContent(
      "240.8k tok recorded at finish (not in the ledger)",
    );
  });

  it("heads the cost as recorded and names unpriced tokens instead of pricing them", async () => {
    list.mockResolvedValue({
      items: [run({ costCents: 150, costUsd: 1.5, unpricedTokens: 100_000 })],
    } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-table");
    expect(table).toHaveTextContent("Cost (as recorded)");
    expect(table).toHaveTextContent("$1.5000 + 100.0k unpriced tok");
    // The re-priced figure the list used to show for these rows.
    expect(table).not.toHaveTextContent("$3.01");
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
    const card = screen.getByTestId("runs-chat-turns");
    expect(card).toHaveTextContent("A chat turn is not a run: it has no timeline to replay.");
    // Whose turns these are, and that a row is not always the whole turn.
    // A chat the owner deleted is still theirs to see here (not "same as session access").
    expect(card).toHaveTextContent(
      "Only chat sessions you own are listed, including chats you have deleted: you can no longer open those, but what they spent is still your spend.",
    );
    expect(card).toHaveTextContent(
      "A turn that used a sub-agent or apply-diff, or that was followed by a conversation summary, spent more than its row",
    );
    // The same cost definition as the runs table, said in the header.
    expect(table).toHaveTextContent("Cost (as recorded)");
  });

  it("names each turn's project, so turns of two projects can be told apart", async () => {
    chatTurns.mockResolvedValue({
      items: [turn(), turn({ id: "t2", projectId: "p-two", sessionId: "chat-b" })],
    } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-chat-turns-table");
    expect(table).toHaveTextContent("Project");
    expect(within(table).getByText("p1")).toBeInTheDocument();
    expect(within(table).getByText("p-two")).toBeInTheDocument();
  });

  it("shows each session's spend outside its turn rows, and the session total", async () => {
    const tokens = (withoutCache: number, withCache: number) => ({ withoutCache, withCache });
    chatTurns.mockResolvedValue({
      items: [turn()],
      sessions: [
        {
          sessionId: "chat-a",
          projectId: "p1",
          turnCount: 3,
          turns: { calls: 5, tokens: tokens(3_190, 4_290), costUsd: 0.00352, unpricedTokens: 55 },
          other: {
            calls: 4,
            tokens: tokens(25_300, 31_100),
            costUsd: 0.1165,
            unpricedTokens: 1_100,
          },
          total: {
            calls: 9,
            tokens: tokens(28_490, 35_390),
            costUsd: 0.12002,
            unpricedTokens: 1_155,
          },
        },
        {
          sessionId: "chat-plain",
          projectId: "p1",
          turnCount: 1,
          turns: { calls: 1, tokens: tokens(1_100, 1_500), costUsd: null, unpricedTokens: 1_500 },
          other: { calls: 0, tokens: tokens(0, 0), costUsd: 0, unpricedTokens: 0 },
          total: { calls: 1, tokens: tokens(1_100, 1_500), costUsd: null, unpricedTokens: 1_500 },
        },
      ],
    } as never);
    renderRuns();
    const table = await screen.findByTestId("runs-chat-sessions-table");
    expect(table).toHaveTextContent("Sub-agents, apply-diff, summaries");
    expect(table).toHaveTextContent("Session total");
    expect(table).toHaveTextContent(
      "3 turns · 5 model calls · 3.2k tok without cache · 4.3k with cache · $0.0035 + 55 unpriced tok",
    );
    expect(table).toHaveTextContent(
      "4 calls · 25.3k tok without cache · 31.1k with cache · $0.1165 + 1.1k unpriced tok",
    );
    expect(table).toHaveTextContent(
      "9 calls · 28.5k tok without cache · 35.4k with cache · $0.1200 + 1.2k unpriced tok",
    );
    // A session with nothing outside its turns says so; an unpriced one is not $0.
    const plain = within(table).getByText("chat-plain").closest("tr") as HTMLElement;
    expect(plain).toHaveTextContent("1 turn · 1 model call · ");
    expect(plain).toHaveTextContent("none");
    expect(plain).toHaveTextContent("1.5k unpriced tok");
    expect(plain).not.toHaveTextContent("$");
  });

  it("shows no session table for a server that sends none", async () => {
    chatTurns.mockResolvedValue({ items: [turn()] } as never);
    renderRuns();
    await screen.findByTestId("runs-chat-turns-table");
    expect(screen.queryByTestId("runs-chat-sessions-table")).not.toBeInTheDocument();
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
      "No chat turns of yours match these filters.",
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
    // No spend after the run: no note.
    expect(screen.queryByTestId("run-tokens-after-run")).not.toBeInTheDocument();
  });

  it("shows the cost as recorded, the same figure as the list row", async () => {
    get.mockResolvedValue(
      detail({ costCents: 150, costUsd: 1.5, unpricedTokens: 100_000 }) as never,
    );
    renderDetail();
    expect(await screen.findByTestId("run-cost")).toHaveTextContent(
      "$1.5000 + 100.0k unpriced tok",
    );
    expect(screen.getByText("Cost (as recorded)")).toBeInTheDocument();
  });

  it("says how much of the figure was recorded after the run finished", async () => {
    get.mockResolvedValue(
      detail({
        tokens: { withoutCache: 576_834, withCache: 970_050 },
        tokensAfterRun: { withoutCache: 339_834, withCache: 393_216 },
      }) as never,
    );
    renderDetail();
    expect(await screen.findByTestId("run-tokens-after-run")).toHaveTextContent(
      "includes 339.8k tok without cache · 393.2k with cache recorded after the run finished",
    );
  });

  it("says the ledger was unavailable when the run's figures could not be read", async () => {
    get.mockResolvedValue(
      detail({ tokens: null, tokensAfterRun: null, costUsd: null, totalTokens: 5_000 }) as never,
    );
    renderDetail();
    expect(await screen.findByTestId("run-tokens")).toHaveTextContent(
      "5.0k tok recorded at finish (ledger unavailable)",
    );
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
