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
 * And one COST: the stored ledger cost, with unpriced tokens said to be
 * unpriced, on every one of those surfaces (review of #1112 — one session read
 * $3.01 on `/runs`, 301¢ on the run's page and $1.50 plus 100,000 unpriced
 * tokens on the header).
 *
 * The chat-turn listing is pinned through the real router in
 * `runs-chat-turns-route.sqlite.test.ts`.
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
const { encodeRequestTokens } = await import("../src/lib/finops/token-tracker.js");

const USER = "u-1007";
const DONE = "an-done";
const GOING = "an-going";
const QUIET = "an-quiet";
const OLD = "an-old";
/** The reviewer's reproduction: its own project, one analysis session. */
const REVIEW_PROJECT = "p-review";
const REVIEWED = "an-reviewed";
/** Sessions of the mixed-project `listRuns` page. */
const MIXED = "s-mixed";
const MIXED_OTHER = "s-mixed-other";
const MIXED_SYSTEM = "s-mixed-system";

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
      for (const id of ["p-a", "p-other", REVIEW_PROJECT]) {
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
        // Recorded at 6.9¢; today's rate card would make it 6.9¢ too, or not —
        // nothing reads the rate card for a cost any more.
        costUsd: 0.069,
        costCents: 7,
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
        // A row from before #761: whole cents only.
        costUsd: null,
        costCents: 2,
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
        // What `recordUsage` stored: each 60,000-token request in the short tier.
        costUsd: 0.0121,
        costCents: 1,
        createdAt: at(12),
        requests: [
          [60_000, 100, 0, 0],
          [60_000, 100, 0, 0],
        ],
      });
      // Spend AFTER the run finished (a deep dive): the stored total never saw it.
      // Recorded UNPRICED (the helper's default): 1,000 tokens of unknown cost.
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

      // ── the reviewer's reproduction (review of #1112) ──
      await db.analysis.create({
        data: {
          id: REVIEWED,
          projectId: REVIEW_PROJECT,
          startedById: USER,
          status: "completed",
          totalTokens: 5,
          startedAt: at(0),
          completedAt: at(9),
        },
      });
      const reviewed = await db.agentRun.create({
        data: {
          sessionId: REVIEWED,
          projectId: REVIEW_PROJECT,
          kind: "analysis",
          status: "completed",
          startedAt: at(0),
          completedAt: at(9),
        },
      });
      runIds.set(REVIEWED, reviewed.id);
      // 1,000,000 Sonnet input tokens stored at $1.00 (today's card: $3.00).
      await usage({
        projectId: REVIEW_PROJECT,
        sessionId: REVIEWED,
        inputTokens: 1_000_000,
        agentStep: "analysis",
        costUsd: 1.0,
        costCents: 100,
        createdAt: at(1),
      });
      // 100,000 tokens stored UNPRICED, of a model that has a price today.
      await usage({
        projectId: REVIEW_PROJECT,
        sessionId: REVIEWED,
        model: "claude-haiku-5-5",
        inputTokens: 100_000,
        agentStep: "analysis",
        createdAt: at(2),
      });
      // Seven tokens stored at $0.50.
      await usage({
        projectId: REVIEW_PROJECT,
        sessionId: REVIEWED,
        inputTokens: 7,
        agentStep: "chat",
        costUsd: 0.5,
        costCents: 50,
        createdAt: at(4),
      });

      // ── one page of `listRuns` holding runs of two projects and a
      // project-less (system) run, where one session id has ledger rows under
      // BOTH projects (review of #1112, cycle 2) ──
      for (const run of [
        { id: "run-mix-a", sessionId: MIXED, projectId: "p-a" },
        { id: "run-mix-other", sessionId: MIXED_OTHER, projectId: "p-other" },
        { id: "run-mix-system", sessionId: MIXED_SYSTEM, projectId: null },
      ]) {
        await db.agentRun.create({
          data: {
            ...run,
            kind: "analysis",
            status: "completed",
            startedAt: at(0),
            completedAt: at(9),
          },
        });
      }
      // The session's own project, then the same session id under the other one.
      await usage({ projectId: "p-a", sessionId: MIXED, inputTokens: 100, createdAt: at(1) });
      await usage({ projectId: "p-other", sessionId: MIXED, inputTokens: 7_000, createdAt: at(2) });
      await usage({
        projectId: "p-other",
        sessionId: MIXED_OTHER,
        inputTokens: 30,
        createdAt: at(3),
      });
      // And the other project's run's session id under the first project.
      await usage({ projectId: "p-a", sessionId: MIXED_OTHER, inputTokens: 900, createdAt: at(3) });
      // A system run has no project: every row of its session is its own.
      await usage({ projectId: "p-a", sessionId: MIXED_SYSTEM, inputTokens: 5, createdAt: at(4) });
      await usage({
        projectId: "p-other",
        sessionId: MIXED_SYSTEM,
        inputTokens: 6,
        createdAt: at(5),
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

    /** The ledger's own cost of a session: what was recorded, and the tokens recorded unpriced. */
    async function sqlCost(projectId: string, sessionId: string) {
      const [row] = await db.$queryRaw<Array<{ costUsd: number | null; unpriced: bigint }>>`
        SELECT
          SUM(COALESCE("costUsd", "costCents" / 100.0)) AS "costUsd",
          COALESCE(SUM(CASE WHEN "costUsd" IS NULL AND "costCents" IS NULL
                            THEN "totalTokens" ELSE 0 END), 0) AS "unpriced"
        FROM "token_usages"
        WHERE "projectId" = ${projectId} AND "sessionId" = ${sessionId}`;
      return { costUsd: Number(row!.costUsd), unpricedTokens: Number(row!.unpriced) };
    }

    it("the cost is the stored ledger cost on every surface, unpriced tokens named", async () => {
      const sql = await sqlCost("p-a", DONE);
      // 6.9¢ + 2¢ (whole-cent row) + 1.21¢; the deep dive's 1,000 tokens have no price.
      expect(sql.costUsd).toBeCloseTo(0.1011, 12);
      expect(sql.unpricedTokens).toBe(1_000);

      const cost = await computeRunCost(runIds.get(DONE)!);
      const listed = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === DONE)!;
      const detail = (await getRun(runIds.get(DONE)!))!.run;
      const header = (await getAnalysisSnapshot(DONE))!.ledgerUsage!;

      expect(cost.tokens).toEqual(DONE_TOKENS);
      expect(cost.totalTokens).toBe(DONE_TOKENS.withCache);
      for (const usd of [cost.costUsd, listed.costUsd, detail.costUsd, header.costUsd]) {
        expect(usd).toBeCloseTo(sql.costUsd, 12);
      }
      expect(detail.costCents).toBe(10);
      for (const unpriced of [
        cost.unpricedTokens,
        listed.unpricedTokens,
        detail.unpricedTokens,
        header.unpricedTokens,
      ]) {
        expect(unpriced).toBe(sql.unpricedTokens);
      }
    });

    it("the reviewer's reproduction: /runs, the run's page and the header give one cost", async () => {
      const sql = await sqlCost(REVIEW_PROJECT, REVIEWED);
      expect(sql).toEqual({ costUsd: 1.5, unpricedTokens: 100_000 });

      const listed = (await listRuns({ projectId: REVIEW_PROJECT }))[0]!;
      const detail = (await getRun(runIds.get(REVIEWED)!))!.run;
      const header = (await getAnalysisSnapshot(REVIEWED))!.ledgerUsage!;

      // It was 3.010021 here, 301 there, and 1.5 with 100,000 unpriced on the header.
      expect(listed.costUsd).toBe(1.5);
      expect(listed.unpricedTokens).toBe(100_000);
      expect(detail.costCents).toBe(150);
      expect(detail.costUsd).toBe(1.5);
      expect(detail.unpricedTokens).toBe(100_000);
      expect(header.costUsd).toBe(1.5);
      expect(header.unpricedTokens).toBe(100_000);
      const tokens = { withoutCache: 1_100_007, withCache: 1_100_007 };
      expect(listed.tokens).toEqual(tokens);
      expect(detail.tokens).toEqual(tokens);
      expect(header.tokens).toEqual(tokens);
    });

    it("says how much of a finished run's figure was recorded after it finished", async () => {
      const [row] = await db.$queryRaw<Array<{ withoutCache: bigint; withCache: bigint }>>`
        SELECT SUM("inputTokens" + "outputTokens") AS "withoutCache",
               SUM("inputTokens" + "outputTokens" + "cacheReadTokens" + "cacheWriteTokens") AS "withCache"
        FROM "token_usages"
        WHERE "projectId" = 'p-a' AND "sessionId" = ${DONE} AND "createdAt" > ${at(30)}`;
      const sql = { withoutCache: Number(row!.withoutCache), withCache: Number(row!.withCache) };
      expect(sql).toEqual({ withoutCache: 1_000, withCache: 1_000 });
      const listed = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === DONE)!;
      expect(listed.tokensAfterRun).toEqual(sql);
      expect((await getRun(runIds.get(DONE)!))!.run.tokensAfterRun).toEqual(sql);
      // A run that is going has finished nothing.
      const going = (await listRuns({ projectId: "p-a" })).find((r) => r.sessionId === GOING)!;
      expect(going.tokensAfterRun).toEqual({ withoutCache: 0, withCache: 0 });
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

    describe("one page holding runs of two projects and a project-less run", () => {
      const figures = (runs: Awaited<ReturnType<typeof listRuns>>) =>
        Object.fromEntries(
          runs
            .filter((r) => r.id.startsWith("run-mix-"))
            .map((r) => [r.id, r.tokens?.withoutCache]),
        );

      it("each run is billed its own project's rows of its session, an admin's unfiltered list", async () => {
        const runs = await listRuns({});
        // All three are on the one page, with runs of a third project too.
        expect(new Set(runs.map((r) => r.projectId))).toEqual(
          new Set(["p-a", "p-other", REVIEW_PROJECT, null]),
        );
        expect(figures(runs)).toEqual({
          // Not 7,100: the 7,000 are the same session id under `p-other`.
          "run-mix-a": 100,
          // Not 930.
          "run-mix-other": 30,
          // No project to scope by: both rows.
          "run-mix-system": 11,
        });
        // The same as each run's own page.
        for (const id of ["run-mix-a", "run-mix-other", "run-mix-system"]) {
          expect((await getRun(id))!.run.tokens!.withoutCache).toBe(figures(runs)[id]);
        }
      });

      it("and a member's list of both projects, where the read names the two projects", async () => {
        const runs = await listRuns({ accessibleProjectIds: ["p-a", "p-other"] });
        expect(runs.some((r) => r.projectId === null)).toBe(false);
        expect(figures(runs)).toEqual({ "run-mix-a": 100, "run-mix-other": 30 });
      });
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
  },
);
