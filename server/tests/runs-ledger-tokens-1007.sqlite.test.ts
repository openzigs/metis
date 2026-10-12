/**
 * Issue #1007 — one run, one set of token figures, against a REAL SQLite
 * database built by the real migration chain.
 *
 * #706 run 5 read three numbers for one run: 439.2k in the run list (the total
 * stored when the run finished), 545.2k in the analysis header (the ledger with
 * cache reads) and 457.9k from the ledger query (input + output). Here every
 * surface — `/runs`, a run's page, the analysis page's run list and its header
 * — is read for the same run and must give the same two figures, and both must
 * equal a direct SQL sum over `token_usages`.
 *
 * It also pins the chat-turn listing: chat turns are read from the ledger, in
 * the caller's projects only.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/prisma.js")>("../src/lib/prisma.js");
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { listRuns, getRun, computeRunCost } = await import("../src/lib/replay/runs-service.js");
const { listAnalysesForProject, getAnalysisSnapshot } =
  await import("../src/lib/analysis/analysis-service.js");
const { listChatTurns } = await import("../src/lib/ai/conversation/chat-turn-ledger.js");
const { encodeRequestTokens, priceLedgerTokensExact } =
  await import("../src/lib/finops/token-tracker.js");
const { getRate } = await import("../src/lib/finops/provider-rates.js");

const USER = "u-1007";
const DONE = "an-done";
const GOING = "an-going";
const QUIET = "an-quiet";
const OLD = "an-old";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1007 run token figures read the ledger (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const runIds = new Map<string, string>();

    interface Usage {
      projectId: string;
      sessionId: string;
      provider?: string;
      model?: string;
      inputTokens: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      agentStep?: string;
      costUsd?: number | null;
      costCents?: number | null;
      createdAt: Date;
      requests?: Array<[number, number, number, number]>;
    }
    async function usage(u: Usage): Promise<void> {
      const { requests, ...row } = u;
      const provider = row.provider ?? "anthropic";
      const outputTokens = row.outputTokens ?? 0;
      const cacheReadTokens = row.cacheReadTokens ?? 0;
      const cacheWriteTokens = row.cacheWriteTokens ?? 0;
      await db.tokenUsage.create({
        data: {
          costCents: null,
          costUsd: null,
          ...row,
          provider,
          model: row.model ?? "claude-3-5-sonnet",
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          // What `recordUsage` stores: the canonical total.
          totalTokens:
            provider === "anthropic"
              ? row.inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens
              : row.inputTokens + outputTokens,
          ...(requests
            ? {
                requestTokens: encodeRequestTokens(
                  requests.map(([i, o, r, w]) => ({
                    inputTokens: i,
                    outputTokens: o,
                    cacheReadTokens: r,
                    cacheWriteTokens: w,
                  })),
                ),
              }
            : {}),
        },
      });
    }

    /**
     * The direct sum the issue asks every surface to match. `anthropic` rows
     * store input without the cache fields; every other provider's input
     * already includes its cache reads.
     */
    async function sqlTokens(projectId: string, sessionId: string) {
      const [row] = await db.$queryRaw<Array<{ withoutCache: bigint; withCache: bigint }>>`
        SELECT
          COALESCE(SUM(CASE WHEN "provider" = 'anthropic' THEN "inputTokens"
                            ELSE "inputTokens" - "cacheReadTokens" END + "outputTokens"), 0) AS "withoutCache",
          COALESCE(SUM(CASE WHEN "provider" = 'anthropic'
                            THEN "inputTokens" + "cacheReadTokens" + "cacheWriteTokens"
                            ELSE "inputTokens" END + "outputTokens"), 0) AS "withCache"
        FROM "token_usages"
        WHERE "projectId" = ${projectId} AND "sessionId" = ${sessionId}`;
      return { withoutCache: Number(row!.withoutCache), withCache: Number(row!.withCache) };
    }

    const at = (minute: number) => new Date(Date.UTC(2026, 9, 9, 10, minute));

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1007-run-tokens");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      for (const id of ["p-a", "p-other"]) {
        await db.project.create({ data: { id, name: id, slug: id, createdById: USER } });
      }
      const analyses = [
        // Finished; the stored total (1,000) is what the lists used to show.
        { id: DONE, status: "completed", totalTokens: 1_000, completedAt: at(30) },
        // Going, with spend so far.
        { id: GOING, status: "running", totalTokens: 0, completedAt: null },
        // Going, nothing spent yet.
        { id: QUIET, status: "running", totalTokens: 0, completedAt: null },
        // From before analysis spend was metered: a stored total, no ledger rows.
        { id: OLD, status: "completed", totalTokens: 240_792, completedAt: at(5) },
      ];
      for (const a of analyses) {
        await db.analysis.create({
          data: {
            id: a.id,
            projectId: "p-a",
            startedById: USER,
            status: a.status,
            totalTokens: a.totalTokens,
            startedAt: at(0),
            completedAt: a.completedAt,
          },
        });
        const run = await db.agentRun.create({
          data: {
            sessionId: a.id,
            projectId: "p-a",
            kind: "analysis",
            status: a.status,
            totalTokens: a.totalTokens,
            startedAt: at(0),
            completedAt: a.completedAt,
          },
        });
        runIds.set(a.id, run.id);
      }

      // ── the finished run ──
      // Native Anthropic: input excludes the 30,000 cache reads.
      await usage({
        projectId: "p-a",
        sessionId: DONE,
        inputTokens: 10_000,
        outputTokens: 2_000,
        cacheReadTokens: 30_000,
        agentStep: "analysis",
        createdAt: at(10),
      });
      // OpenAI convention: the 8,000 prompt tokens INCLUDE 5,000 cache reads.
      await usage({
        projectId: "p-a",
        sessionId: DONE,
        provider: "openai",
        model: "gpt-4o",
        inputTokens: 8_000,
        outputTokens: 1_000,
        cacheReadTokens: 5_000,
        agentStep: "analysis",
        createdAt: at(11),
      });
      // One row summing two model calls (#1080), each under Haiku 5.5's
      // 100,000-token long-prompt threshold; together they are over it.
      await usage({
        projectId: "p-a",
        sessionId: DONE,
        model: "claude-haiku-5-5",
        inputTokens: 120_000,
        outputTokens: 200,
        agentStep: "analysis",
        createdAt: at(12),
        requests: [
          [60_000, 100, 0, 0],
          [60_000, 100, 0, 0],
        ],
      });
      // Spend AFTER the run finished (a deep dive): the stored total never saw it.
      await usage({
        projectId: "p-a",
        sessionId: DONE,
        inputTokens: 500,
        outputTokens: 500,
        agentStep: "analysis",
        createdAt: at(45),
      });
      // The same session id under ANOTHER project — never this run's spend.
      await usage({
        projectId: "p-other",
        sessionId: DONE,
        inputTokens: 7_000,
        agentStep: "analysis",
        createdAt: at(13),
      });

      // ── the run that is going ──
      await usage({
        projectId: "p-a",
        sessionId: GOING,
        inputTokens: 1_000,
        outputTokens: 100,
        cacheReadTokens: 4_000,
        agentStep: "analysis",
        createdAt: at(50),
      });

      // ── chat turns ──
      // A turn that ran a tool loop: one row, three model calls, 0.042¢.
      await usage({
        projectId: "p-a",
        sessionId: "chat-a",
        inputTokens: 900,
        outputTokens: 90,
        cacheReadTokens: 300,
        agentStep: "chat",
        costUsd: 0.00042,
        costCents: 0,
        createdAt: at(20),
        requests: [
          [300, 30, 0, 0],
          [300, 30, 100, 0],
          [300, 30, 200, 0],
        ],
      });
      await usage({
        projectId: "p-a",
        sessionId: "chat-a",
        inputTokens: 50,
        outputTokens: 5,
        agentStep: "chat-estimated",
        createdAt: at(21),
      });
      await usage({
        projectId: "p-other",
        sessionId: "chat-other",
        inputTokens: 600,
        agentStep: "chat",
        costUsd: 0.5,
        createdAt: at(22),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    // 12,000 + 4,000 + 120,200 + 1,000, and with cache 42,000 + 9,000 + 120,200 + 1,000.
    const DONE_TOKENS = { withoutCache: 137_200, withCache: 172_200 };

    it("the direct SQL sum is the figure under test", async () => {
      expect(await sqlTokens("p-a", DONE)).toEqual(DONE_TOKENS);
    });

    it("/runs, the run's page, the analysis run list and the analysis header agree with it", async () => {
      const sql = await sqlTokens("p-a", DONE);

      const listed = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === DONE)!;
      const detail = await getRun(runIds.get(DONE)!);
      const pastRun = (await listAnalysesForProject("p-a")).find((r) => r.id === DONE)!;
      const header = (await getAnalysisSnapshot(DONE))!.ledgerUsage!;

      expect(listed.tokens).toEqual(sql);
      expect(detail!.run.tokens).toEqual(sql);
      expect(pastRun.ledgerTokens).toEqual(sql);
      expect(header.tokens).toEqual(sql);
      // The stored total is still there, and is none of them.
      expect(listed.totalTokens).toBe(1_000);
      expect(pastRun.totalTokens).toBe(1_000);
    });

    it("prices the run from the same rows, the summed row request by request", async () => {
      const cost = await computeRunCost(runIds.get(DONE)!);
      expect(cost.tokens).toEqual(DONE_TOKENS);
      expect(cost.totalTokens).toBe(DONE_TOKENS.withCache);
      const listed = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === DONE)!;
      expect(listed.costUsd).toBeCloseTo(cost.costUsd, 12);

      // Each row priced on its own by the ledger's row pricer, then summed.
      const haiku = {
        inputTokens: 120_000,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const half = {
        inputTokens: 60_000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      const haikuRate = getRate("anthropic", "claude-haiku-5-5");
      const perRequest = priceLedgerTokensExact("anthropic", haikuRate, haiku, [half, half])!;
      const asOneRequest = priceLedgerTokensExact("anthropic", haikuRate, haiku, null)!;
      // Two 60,000-token requests: 120,000 × $0.10/M + 200 × $0.50/M = 1.21¢.
      // As one 120,000-token request it is over the threshold: 6.05¢.
      expect(perRequest).toBeCloseTo(1.21, 10);
      expect(asOneRequest).toBeCloseTo(6.05, 10);
      const sonnet = priceLedgerTokensExact(
        "anthropic",
        getRate("anthropic", "claude-3-5-sonnet"),
        { inputTokens: 10_500, outputTokens: 2_500, cacheReadTokens: 30_000, cacheWriteTokens: 0 },
        null,
      )!;
      const gpt = priceLedgerTokensExact(
        "openai",
        getRate("openai", "gpt-4o"),
        { inputTokens: 8_000, outputTokens: 1_000, cacheReadTokens: 5_000, cacheWriteTokens: 0 },
        null,
      )!;
      expect(cost.costUsd * 100).toBeCloseTo(sonnet + gpt + perRequest, 9);
    });

    it("a run that is going shows its ledger total so far, not 0", async () => {
      const sql = await sqlTokens("p-a", GOING);
      expect(sql).toEqual({ withoutCache: 1_100, withCache: 5_100 });
      const listed = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === GOING)!;
      const pastRun = (await listAnalysesForProject("p-a")).find((r) => r.id === GOING)!;
      expect(listed).toMatchObject({ status: "running", totalTokens: 0, tokens: sql });
      expect(pastRun).toMatchObject({ status: "running", totalTokens: 0, ledgerTokens: sql });
      expect((await getRun(runIds.get(GOING)!))!.run.tokens).toEqual(sql);
    });

    it("a run with no ledger rows reads zero from the ledger and keeps its stored total", async () => {
      const zero = { withoutCache: 0, withCache: 0 };
      const runs = await listRuns({ projectId: "p-a" });
      const analyses = await listAnalysesForProject("p-a");
      for (const id of [QUIET, OLD]) {
        expect(runs.find((r) => r.sessionId === id)!.tokens).toEqual(zero);
        expect(analyses.find((r) => r.id === id)!.ledgerTokens).toEqual(zero);
      }
      expect(runs.find((r) => r.sessionId === OLD)!.totalTokens).toBe(240_792);
      expect((await getAnalysisSnapshot(OLD))!.ledgerUsage!.tokens).toEqual(zero);
    });

    describe("chat turns", () => {
      it("lists a project's chat turns from the ledger, newest first, with the exact cost", async () => {
        const turns = await listChatTurns({ projectId: "p-a" });
        expect(turns.map((t) => [t.sessionId, t.step, t.requests])).toEqual([
          ["chat-a", "chat-estimated", 1],
          ["chat-a", "chat", 3],
        ]);
        const turn = turns[1]!;
        expect(turn.tokens).toEqual(await sqlTokensOfStep("chat"));
        expect(turn.tokens).toEqual({ withoutCache: 990, withCache: 1_290 });
        // A fraction of a cent, as recorded; whole cents would read 0.
        expect(turn.costUsd).toBeCloseTo(0.00042, 12);
        // An unpriced row says so rather than reading $0.
        expect(turns[0]!.costUsd).toBeNull();
      });

      async function sqlTokensOfStep(step: string) {
        const [row] = await db.$queryRaw<Array<{ withoutCache: bigint; withCache: bigint }>>`
          SELECT SUM("inputTokens" + "outputTokens") AS "withoutCache",
                 SUM("inputTokens" + "outputTokens" + "cacheReadTokens" + "cacheWriteTokens") AS "withCache"
          FROM "token_usages" WHERE "projectId" = 'p-a' AND "agentStep" = ${step}`;
        return { withoutCache: Number(row!.withoutCache), withCache: Number(row!.withCache) };
      }

      it("never lists an analysis row as a chat turn", async () => {
        const turns = await listChatTurns({});
        expect(turns.every((t) => t.step.startsWith("chat"))).toBe(true);
        expect(turns).toHaveLength(3);
      });

      it("keeps a caller to their own projects, whatever they filter by", async () => {
        const mine = { accessibleProjectIds: ["p-a"] };
        expect((await listChatTurns(mine)).map((t) => t.projectId)).toEqual(["p-a", "p-a"]);
        // Another project's session id, or its project id, surfaces nothing.
        expect(await listChatTurns({ ...mine, sessionId: "chat-other" })).toEqual([]);
        expect(await listChatTurns({ ...mine, projectId: "p-other" })).toEqual([]);
        expect(await listChatTurns({ accessibleProjectIds: [] })).toEqual([]);
        // An admin (no narrowing) sees it.
        expect(await listChatTurns({ sessionId: "chat-other" })).toHaveLength(1);
      });

      it("filters by session and time, and caps the page", async () => {
        expect(await listChatTurns({ projectId: "p-a", sessionId: "chat-a" })).toHaveLength(2);
        expect(await listChatTurns({ projectId: "p-a", from: at(21) })).toHaveLength(1);
        expect(await listChatTurns({ projectId: "p-a", to: at(20) })).toHaveLength(1);
        expect(await listChatTurns({ limit: 1 })).toHaveLength(1);
        expect(await listChatTurns({ limit: 0 })).toHaveLength(3);
      });
    });
  },
);
