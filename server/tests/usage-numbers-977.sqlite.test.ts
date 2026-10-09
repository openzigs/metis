/**
 * #977 — usage numbers users trust, against a REAL SQLite database built by
 * the real migration chain.
 *
 *   - `sumLedgerUsage` sums the unrounded ledger cost in the database: the
 *     `costCents` fallback for a row with no `costUsd`, unpriced rows apart,
 *     and the caller's scope (a session, a workspace's projects) honoured.
 *   - A RUNNING analysis's snapshot carries its ledger spend so far, scoped to
 *     its own session and project, while `Analysis.totalTokens` is still 0.
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

const { sumLedgerUsage } = await import("../src/lib/finops/ledger-totals.js");
const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");

const USER = "u-977";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#977 ledger totals and live analysis spend (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    async function row(data: {
      projectId: string;
      sessionId?: string;
      totalTokens: number;
      costUsd?: number | null;
      costCents?: number | null;
    }): Promise<void> {
      await db.tokenUsage.create({
        data: {
          provider: "openai",
          model: "gpt-4o-mini",
          inputTokens: data.totalTokens,
          outputTokens: 0,
          costCents: null,
          costUsd: null,
          ...data,
        },
      });
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("977-usage");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@x.test` },
      });
      await db.workspace.create({ data: { id: "ws-977", name: "ws", slug: "ws-977" } });
      for (const [id, workspaceId] of [
        ["p-a", "ws-977"],
        ["p-b", "ws-977"],
        ["p-other", undefined],
      ] as const) {
        await db.project.create({
          data: {
            id,
            name: id,
            slug: id,
            createdById: USER,
            ...(workspaceId ? { workspaceId } : {}),
          },
        });
      }
      await db.analysis.create({
        data: { id: "an-977", projectId: "p-a", startedById: USER, status: "running" },
      });

      // The running analysis's own calls: 0.075¢ each — whole cents read 0.
      await row({ projectId: "p-a", sessionId: "an-977", totalTokens: 2_000, costUsd: 0.00075 });
      await row({ projectId: "p-a", sessionId: "an-977", totalTokens: 2_000, costUsd: 0.00075 });
      // An unpriced call in the same run (#22).
      await row({ projectId: "p-a", sessionId: "an-977", totalTokens: 900 });
      // Same project, another session (chat) — not the analysis's spend.
      await row({ projectId: "p-a", sessionId: "chat-1", totalTokens: 5_000, costUsd: 0.01 });
      // Same session id under ANOTHER project — must not leak in.
      await row({ projectId: "p-other", sessionId: "an-977", totalTokens: 7_000, costUsd: 1 });
      // Workspace sibling with a legacy costCents-only row (#868).
      await row({ projectId: "p-b", sessionId: "s-b", totalTokens: 1_000, costCents: 3 });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("sums one session's priced cost unrounded and keeps unpriced tokens apart", async () => {
      const t = await sumLedgerUsage({ projectId: "p-a", sessionId: "an-977" });
      expect(t.totalTokens).toBe(4_900);
      expect(t.costUsd).toBeCloseTo(0.0015, 10);
      expect(t.unpricedTokens).toBe(900);
      expect(t.calls).toBe(3);
    });

    it("sums a workspace's projects, adding a legacy costCents-only row", async () => {
      const t = await sumLedgerUsage({ project: { workspaceId: "ws-977" } });
      expect(t.totalTokens).toBe(4_900 + 5_000 + 1_000);
      // 0.0015 + 0.01 + 0.03 (legacy 3¢); p-other's $1 is excluded.
      expect(t.costUsd).toBeCloseTo(0.0415, 10);
      expect(t.calls).toBe(5);
    });

    it("an all-unpriced slice costs null (unknown), an empty one 0", async () => {
      const unpricedOnly = await sumLedgerUsage({
        projectId: "p-a",
        sessionId: "an-977",
        costUsd: null,
        costCents: null,
      });
      expect(unpricedOnly.costUsd).toBeNull();
      expect(unpricedOnly.unpricedTokens).toBe(900);
      const empty = await sumLedgerUsage({ projectId: "p-a", sessionId: "nope" });
      expect(empty).toEqual({ totalTokens: 0, costUsd: 0, unpricedTokens: 0, calls: 0 });
    });

    it("a running analysis's snapshot shows its ledger spend while totalTokens is still 0", async () => {
      const snap = await getAnalysisSnapshot("an-977");
      expect(snap?.status).toBe("running");
      expect(snap?.totalTokens).toBe(0);
      expect(snap?.ledgerUsage?.totalTokens).toBe(4_900);
      expect(snap?.ledgerUsage?.costUsd).toBeCloseTo(0.0015, 10);
      expect(snap?.ledgerUsage?.unpricedTokens).toBe(900);
    });
  },
);
