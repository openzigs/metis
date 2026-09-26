/**
 * #212 — the transcript store's batched fork copy and paged read, proven against
 * a REAL Postgres.
 *
 * Fork (`copyTranscriptPrefix`) now inserts the copied prefix with one
 * `createMany` instead of a `create` per row. The SQLite route suite
 * (`ai-conversation.sqlite.test.ts`) proves it on the better-sqlite3 adapter;
 * this suite runs the same store functions on the pg adapter, so "works on both"
 * is measured, not assumed:
 *
 *   - the copy lands in one statement with the same ordinals, and a copied
 *     row's `compactedIntoId` points at the copied summary in the same batch;
 *   - a batch that clashes on the `(sessionId, ordinal)` unique index writes
 *     NOTHING (the unit fake models exactly this);
 *   - the paged read returns `hasMore` and the compaction state of earlier rows
 *     folded by a summary on the page.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped (via
 * `pnpm test:integration`). CI's `postgres-adapter` job provides the database and
 * syncs the schema with `prisma db push` before this runs.
 */
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { selectPrismaAdapter } from "../src/lib/prisma.js";
import {
  appendMessage,
  copyTranscriptPrefix,
  listMessages,
  listMessagesPage,
} from "../src/lib/ai/conversation/transcript-store.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

describe.runIf(enabled)("Transcript fork + paging on real Postgres (integration, #212)", () => {
  const db = new PrismaClient({ adapter: selectPrismaAdapter(databaseUrl) });
  const tag = randomUUID().slice(0, 8);
  const userId = `u-212-${tag}`;
  const sessionIds: string[] = [];

  async function newSession(): Promise<string> {
    const s = await db.aISession.create({
      data: { userId, title: "t", provider: "offline-stub", model: "m", policy: "{}" },
    });
    sessionIds.push(s.id);
    return s.id;
  }

  const text = (t: string) => ({
    role: "user" as const,
    parts: [{ type: "text" as const, text: t }],
    estimatedTokens: 1,
  });

  beforeAll(async () => {
    await db.user.create({
      data: { id: userId, username: userId, displayName: userId, email: `${userId}@example.test` },
    });
  });

  afterAll(async () => {
    await db.aIMessage.deleteMany({ where: { sessionId: { in: sessionIds } } });
    await db.aISession.deleteMany({ where: { id: { in: sessionIds } } });
    await db.user.deleteMany({ where: { id: userId } });
    await db.$disconnect();
  });

  it("copies the prefix in one batch, keeping ordinals and re-pointing compaction", async () => {
    const src = await newSession();
    for (let i = 1; i <= 4; i++) await appendMessage(src, text(`m${i}`), db);
    const summary = await appendMessage(
      src,
      { role: "system", kind: "summary", parts: [{ type: "text", text: "S" }], estimatedTokens: 1 },
      db,
    );
    await db.aIMessage.updateMany({
      where: { sessionId: src, ordinal: { lte: 2 } },
      data: { compactedAt: new Date(), compactedIntoId: summary.id },
    });

    const dst = await newSession();
    expect(await copyTranscriptPrefix(src, dst, 5, db)).toBe(5);
    const copied = await listMessages(dst, db);
    expect(copied.map((r) => r.ordinal)).toEqual([1, 2, 3, 4, 5]);
    const copiedSummary = copied.find((r) => r.kind === "summary")!;
    expect(copiedSummary.id).not.toBe(summary.id);
    expect(
      copied.filter((r) => r.compactedIntoId === copiedSummary.id).map((r) => r.ordinal),
    ).toEqual([1, 2]);
  });

  it("a batch that clashes on (sessionId, ordinal) writes nothing", async () => {
    const src = await newSession();
    for (let i = 1; i <= 3; i++) await appendMessage(src, text(`m${i}`), db);
    const dst = await newSession();
    await appendMessage(dst, text("already here"), db);
    await expect(copyTranscriptPrefix(src, dst, 3, db)).rejects.toMatchObject({ code: "P2002" });
    expect(await db.aIMessage.count({ where: { sessionId: dst } })).toBe(1);
  });

  it("pages with hasMore and reports rows folded by a summary on the page", async () => {
    const sid = await newSession();
    for (let i = 1; i <= 4; i++) await appendMessage(sid, text(`m${i}`), db);
    const summary = await appendMessage(
      sid,
      { role: "system", kind: "summary", parts: [{ type: "text", text: "S" }], estimatedTokens: 1 },
      db,
    );
    await db.aIMessage.updateMany({
      where: { sessionId: sid, ordinal: { lte: 3 } },
      data: { compactedAt: new Date(), compactedIntoId: summary.id },
    });
    const first = await listMessagesPage(sid, { afterOrdinal: 0, limit: 2 }, db);
    expect(first.rows.map((r) => r.ordinal)).toEqual([1, 2]);
    expect(first).toMatchObject({ hasMore: true, nextAfterOrdinal: 2 });
    const delta = await listMessagesPage(sid, { afterOrdinal: 4, limit: 10 }, db);
    expect(delta.rows.map((r) => r.ordinal)).toEqual([5]);
    expect(delta.hasMore).toBe(false);
    expect(delta.compactionUpdates.map((u) => u.ordinal)).toEqual([1, 2, 3]);
  });
});
