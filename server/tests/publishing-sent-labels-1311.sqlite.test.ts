/**
 * Issue #1311 — a published issue's row records the labels METIS sent it
 * (`PublishedIssue.sentLabels`), and the next publish whose body is unchanged
 * compares with that record, so a change to the draft's own labels relabels
 * the issue. Proven against a REAL SQLite database built by the real migration
 * chain: the write and the read both go through the generated client, so a
 * column the migration never added, or a value the next run never reads back,
 * fails here. GitHub is a recording fake.
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
import realIssueFixture from "./fixtures/github-rest-issue.json" with { type: "json" };
import type { OctokitRequestArgs, PublishOctokitLike } from "../src/lib/publishing/types.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "api.github.com",
    address: "10.20.30.40",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));
vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async (ref: string | null) => (ref ? `tok-${ref}` : null)),
}));
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn(() => ({})) }));

const { runBatch } = await import("../src/lib/publishing/publisher.js");
const { __resetPublishOctokitCache, __setPublishOctokitFactory } =
  await import("../src/lib/publishing/octokit-factory.js");
type Call = { method: string; url: string; data: unknown };

const T0 = "2026-09-01T00:00:00.000Z";

/** A fake GitHub that records every issue call and answers as GitHub does. */
function recordingGitHub(): Call[] {
  const calls: Call[] = [];
  let next = 100;
  __resetPublishOctokitCache();
  // `request<T>` is caller-typed on the real client, so a fake is cast, as in
  // publishing-publisher.test.ts.
  const client = {
    request: async (args: OctokitRequestArgs) => {
      const method = args.method ?? "GET";
      const url = args.url ?? "";
      if (/\/issues/.test(url)) calls.push({ method, url, data: args.data });
      if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url)) {
        return { status: 200, headers: {}, data: { permissions: { push: true } } };
      }
      const issue = (number: number) => ({
        ...(realIssueFixture as object),
        id: 4_993_133_000 + number,
        node_id: `I_kwDOfake${number}`,
        number,
        html_url: `https://github.com/acme/metis/issues/${number}`,
        repository_url: "https://api.github.com/repos/acme/metis",
      });
      if (method === "POST" && /\/issues$/.test(url)) {
        next += 1;
        return { status: 201, headers: {}, data: issue(next) };
      }
      if (method === "PATCH" && /\/issues\/\d+$/.test(url)) {
        return { status: 200, headers: {}, data: issue(Number(url.split("/").pop())) };
      }
      return { status: 200, headers: {}, data: { name: "ok" } };
    },
  };
  __setPublishOctokitFactory(async () => client as PublishOctokitLike);
  return calls;
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1311 — PublishedIssue.sentLabels is written and read back (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1311-sent-labels");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.project.create({
        data: { id: "p1", name: "P1", slug: "p1", createdById: "u1" },
      });
      await db.issueDraft.create({
        data: {
          id: "d1",
          projectId: "p1",
          title: "[Feature] Login",
          body: "login body",
          labels: JSON.stringify(["feature"]),
          status: "approved",
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      __setPublishOctokitFactory(null);
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    async function publish(): Promise<{ batchId: string; calls: Call[] }> {
      const calls = recordingGitHub();
      const batch = await db.publishBatch.create({
        data: {
          projectId: "p1",
          targetOwner: "acme",
          targetRepo: "metis",
          startedById: "u1",
          metadata: JSON.stringify({
            draftIds: ["d1"],
            additionalLabels: ["sprint-42"],
            secretRef: "${vault:gh}",
          }),
        },
      });
      await runBatch({
        batchId: batch.id,
        dryRun: false,
        secretRef: "${vault:gh}",
        sleep: async () => {},
      });
      return { batchId: batch.id, calls };
    }

    const rowOf = (batchId: string) =>
      db.publishedIssue.findFirstOrThrow({ where: { batchId, draftId: "d1" } });

    it("the created issue's row holds the labels it was sent", async () => {
      const { batchId, calls } = await publish();
      expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
      expect(JSON.parse((await rowOf(batchId)).sentLabels!)).toEqual(["feature", "sprint-42"]);
    });

    it("the draft's labels change, its body does not: the next publish relabels the issue", async () => {
      await db.issueDraft.update({
        where: { id: "d1" },
        data: { labels: JSON.stringify(["feature", "security"]), status: "approved" },
      });
      const { batchId, calls } = await publish();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([
        {
          method: "PATCH",
          url: "/repos/acme/metis/issues/101",
          data: { labels: ["feature", "security", "sprint-42"] },
        },
      ]);
      const row = await rowOf(batchId);
      expect(row.status).toBe("updated");
      expect(JSON.parse(row.sentLabels!)).toEqual(["feature", "security", "sprint-42"]);
    });

    it("nothing changed since: the issue is left alone", async () => {
      await db.issueDraft.update({ where: { id: "d1" }, data: { status: "approved" } });
      const { calls } = await publish();
      expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    });
  },
);
