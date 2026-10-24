/**
 * #1486 — a PR review's run reports what its review spent. The spend row is
 * written under the run's own session, which is what `computeRunCost` reads,
 * on a posted review and on one GitHub refused.
 *
 * Against a REAL SQLite database built from the migration chain, with the real
 * `runs-service` (`startRun` / `computeRunCost` / `finishRun`) and the real
 * budget guard (`checkBudget` / `recordPrReviewSpend`). Only the acceptance-
 * criteria resolver and the diff fetch are stubbed, plus the judge and Octokit,
 * so no model runs and nothing reaches GitHub.
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
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/agents/pr-reviewer/ac-traceability.js", () => ({
  resolveAcceptanceCriteriaForPr: async () => ({
    criteria: [{ id: "AC-1", text: "The thing works" }],
    linkedIssueNumbers: [5],
  }),
}));
vi.mock("../src/lib/agents/pr-reviewer/diff-fetcher.js", () => ({
  fetchPrDiff: async () => ({ diff: "@@ -1 +1 @@\n+x\n", tooLarge: false, rawBytes: 12 }),
}));

const { executePrReviewJob } = await import("../src/lib/agents/pr-reviewer/pr-review-job.js");

const PROJECT = "project-1486";

const JUDGE_OK = JSON.stringify({
  verdicts: [{ acId: "AC-1", verdict: "satisfied", reasoning: "ok", evidenceFiles: [] }],
  comments: [],
  overallVerdict: "approve",
  summary: "Looks good",
});

/** A stub judge answering after a few ms, as a model does, for $0.05. */
const judge = {
  evaluate: async () => {
    await new Promise((r) => setTimeout(r, 5));
    return {
      raw: JUDGE_OK,
      model: "claude-sonnet-4-5",
      provider: "anthropic",
      inputTokens: 1000,
      outputTokens: 200,
      costUsd: 0.05,
    };
  },
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1486 — a PR review's run reports what the review spent",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1486-pr-review-run-cost");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-1486", username: "u-1486", displayName: "u", email: "u-1486@example.test" },
      });
      await db.workspace.create({ data: { id: "ws-1486", name: "ws", slug: "ws-1486" } });
      await db.project.create({
        data: {
          id: PROJECT,
          name: PROJECT,
          slug: PROJECT,
          createdById: "u-1486",
          workspaceId: "ws-1486",
          status: "active",
          autoReviewPrs: true,
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    const run = (deliveryId: string, prNumber: number, octokit: unknown) =>
      executePrReviewJob(
        {
          job: {
            deliveryId,
            projectId: PROJECT,
            owner: "acme",
            repo: "app",
            prNumber,
            context: { action: "opened", headSha: "sha" },
            attempt: 1,
            enqueuedAt: 0,
          },
          project: {
            id: PROJECT,
            autoReviewPrs: true,
            prReviewMaxDiffBytes: null,
            prReviewSkipGlobs: null,
          },
          prTitle: "t",
          prBody: "Closes #5",
          prUrl: `https://github.com/acme/app/pull/${prNumber}`,
          installationId: null,
          actor: { type: "webhook", id: null },
        },
        { judge, octokit: octokit as never },
      );

    const spendOf = async (sessionId: string) =>
      (await db.tokenUsage.findMany({ where: { projectId: PROJECT, sessionId } })).map(
        (r) => r.costCents,
      );

    it("a posted review: the run's cost is the spend written, under its session", async () => {
      const octokit = {
        pulls: {
          createReview: async () => ({
            data: { id: 1, html_url: "https://github.com/acme/app/pull/1#r1" },
          }),
        },
      };
      const out = await run("delivery-ok", 1, octokit);
      const agentRun = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId! } });
      expect(agentRun.sessionId).toBe("pr-review-1-delivery-ok");
      expect(await spendOf(agentRun.sessionId)).toEqual([5]);
      expect(agentRun.status).toBe("completed");
      expect(agentRun.costCents).toBe(5);
      expect(agentRun.totalTokens).toBe(1200);
    });

    it("a review GitHub refused: the failed run still reports the spend", async () => {
      const octokit = {
        pulls: {
          createReview: async () => {
            throw Object.assign(new Error("Unprocessable Entity"), { status: 422 });
          },
        },
      };
      const out = await run("delivery-refused", 2, octokit);
      const agentRun = await db.agentRun.findUniqueOrThrow({ where: { id: out.runId! } });
      expect(await spendOf(agentRun.sessionId)).toEqual([5]);
      expect(agentRun.status).toBe("failed");
      expect(agentRun.costCents).toBe(5);
      expect(agentRun.totalTokens).toBe(1200);
    });
  },
);
