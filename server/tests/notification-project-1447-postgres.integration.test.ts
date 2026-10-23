/**
 * #1447 — the notification `projectId` backfill, on a REAL Postgres.
 *
 * The Postgres twin of the migration reads the payload with a regex rather
 * than SQLite's `json_extract`, so the SQLite backfill test
 * (`notifications-access-1447.sqlite.test.ts`) does not cover it, and
 * `postgres-migrate-deploy` replays the chain from an EMPTY database, where the
 * backfill never meets a row. This runs the Postgres `migration.sql` verbatim
 * over seeded legacy rows in a scratch schema, as `user-identity-1395-postgres`
 * does: `notifications` is cloned from the pushed table minus the column the
 * migration adds; the tables it joins are created with just the columns it reads.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const MIGRATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "prisma",
  "postgres",
  "migrations",
  "20261028001447_issue1447_notification_project_id",
  "migration.sql",
);

describe.runIf(enabled)("#1447 notification projectId backfill on real Postgres", () => {
  const client = new pg.Client({ connectionString: databaseUrl });
  // A fixed prefix plus random hex: safe to interpolate as an identifier.
  const schema = `t1447_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const q = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) =>
    client.query<T>(sql, params);

  const insertLegacy = (
    id: string,
    type: string,
    payload: string | null,
    commentId: string | null = null,
  ) =>
    q(
      `INSERT INTO "notifications" ("id","userId","type","title","message","payload","commentId")
       VALUES ($1, 'u-1', $2, 't', 'm', $3, $4)`,
      [id, type, payload, commentId],
    );

  beforeAll(async () => {
    await client.connect();
    await q(`CREATE SCHEMA "${schema}"`);
    await q(
      `CREATE TABLE "${schema}"."notifications" (LIKE public."notifications" INCLUDING DEFAULTS)`,
    );
    await q(`ALTER TABLE "${schema}"."notifications" DROP COLUMN "projectId"`);
    await q(`SET search_path TO "${schema}"`);
    await q(`CREATE TABLE "requirements" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL)`);
    await q(
      `CREATE TABLE "comment_threads" ("id" TEXT PRIMARY KEY, "requirementId" TEXT, "specKitProjectId" TEXT)`,
    );
    await q(`CREATE TABLE "comments" ("id" TEXT PRIMARY KEY, "threadId" TEXT NOT NULL)`);
    await q(`CREATE TABLE "discussion_threads" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL)`);
    await q(`CREATE TABLE "review_requests" ("id" TEXT PRIMARY KEY, "projectId" TEXT NOT NULL)`);

    await q(`INSERT INTO "requirements" VALUES ('req-1','p-req'), ('req-sla','p-sla')`);
    await q(
      `INSERT INTO "comment_threads" VALUES ('ct-req','req-1',NULL), ('ct-spec',NULL,'p-spec')`,
    );
    await q(`INSERT INTO "comments" VALUES ('c-req','ct-req'), ('c-spec','ct-spec')`);
    await q(`INSERT INTO "discussion_threads" VALUES ('dt-1','p-disc')`);
    await q(`INSERT INTO "review_requests" VALUES ('rr-1','p-review')`);

    // #1318-era mention: commentId column set, payload without it.
    await insertLegacy("n-mention-col", "mention", JSON.stringify({ kind: "mention" }), "c-req");
    // Pre-#1318 mention: commentId only in the payload, Spec Kit thread.
    await insertLegacy(
      "n-mention-payload",
      "mention",
      JSON.stringify({ kind: "mention", commentId: "c-spec", ts: 1 }),
    );
    await insertLegacy(
      "n-disc",
      "discussion_mention",
      JSON.stringify({ kind: "discussion_mention", threadId: "dt-1", messageId: "m-1" }),
    );
    for (const type of [
      "review_requested",
      "review_decided",
      "review_approved",
      "review_rejected",
    ]) {
      // The echoed projectId is deliberately wrong: the backfill must follow
      // the review, not trust the payload.
      await insertLegacy(
        `n-${type}`,
        type,
        JSON.stringify({ kind: type, reviewId: "rr-1", userId: "u-1", projectId: "p-wrong" }),
      );
    }
    await insertLegacy(
      "n-sla",
      "sla_deadline",
      JSON.stringify({ assignmentId: "a-1", requirementId: "req-sla", requirementTitle: "r" }),
    );
    // Unresolvable: malformed payload, target gone, no payload, unknown type.
    await insertLegacy("n-bad-json", "discussion_mention", "{not json");
    await insertLegacy("n-gone", "discussion_mention", JSON.stringify({ threadId: "dt-gone" }));
    await insertLegacy("n-null-payload", "sla_deadline", null);
    await insertLegacy("n-other", "something_else", JSON.stringify({ projectId: "p-req" }));
    // A key planted inside a user-controlled string is never read: the real
    // top-level key wins even when the planted one comes first...
    await insertLegacy(
      "n-sla-planted-first",
      "sla_deadline",
      JSON.stringify({ requirementTitle: 'x "requirementId":"req-1" y', requirementId: "req-sla" }),
    );
    // ...and a payload whose ONLY occurrence is planted resolves to nothing,
    // including one shaped like a whole object or a `,`-led key.
    await insertLegacy(
      "n-sla-planted-only",
      "sla_deadline",
      JSON.stringify({ requirementTitle: '{"requirementId":"req-1"}', assignmentId: "a-1" }),
    );
    await insertLegacy(
      "n-disc-planted-only",
      "discussion_mention",
      JSON.stringify({ kind: "discussion_mention", title: 'a,"threadId":"dt-1"' }),
    );

    before = await versions();
    await q(readFileSync(MIGRATION, "utf8"));
  });

  afterAll(async () => {
    await q(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await client.end();
  });

  /** Each row's `xmin`: it changes exactly when the row is rewritten. */
  async function versions(): Promise<Record<string, string>> {
    const { rows } = await q<{ id: string; v: string }>(
      `SELECT "id", xmin::text AS "v" FROM "notifications"`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.v]));
  }
  let before: Record<string, string> = {};

  const projectIds = async () => {
    const { rows } = await q<{ id: string; projectId: string | null }>(
      `SELECT "id", "projectId" FROM "notifications"`,
    );
    return Object.fromEntries(rows.map((r) => [r.id, r.projectId]));
  };

  const RESOLVED = {
    "n-mention-col": "p-req",
    "n-mention-payload": "p-spec",
    "n-disc": "p-disc",
    "n-review_requested": "p-review",
    "n-review_decided": "p-review",
    "n-review_approved": "p-review",
    "n-review_rejected": "p-review",
    "n-sla": "p-sla",
    "n-sla-planted-first": "p-sla",
  };
  const EXPECTED = {
    ...RESOLVED,
    "n-sla-planted-only": null,
    "n-disc-planted-only": null,
    "n-bad-json": null,
    "n-gone": null,
    "n-null-payload": null,
    "n-other": null,
  };

  it("gives every resolvable row its project and leaves the rest NULL", async () => {
    expect(await projectIds()).toEqual(EXPECTED);
  });

  it("writes ONLY the rows that resolve to a project — never rewrites the rest", async () => {
    const after = await versions();
    const rewritten = Object.keys(after).filter((id) => after[id] !== before[id]);
    expect(rewritten.sort()).toEqual(Object.keys(RESOLVED).sort());
  });

  it("is re-runnable: a second pass rewrites no row at all", async () => {
    const first = await versions();
    await q(readFileSync(MIGRATION, "utf8"));
    expect(await projectIds()).toEqual(EXPECTED);
    expect(await versions()).toEqual(first);
  });
});
