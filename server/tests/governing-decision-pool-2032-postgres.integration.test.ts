/**
 * #2032 — a BA's decision on a governing finding, on real Postgres, from a
 * pool of ONE connection.
 *
 * `decideGoverningFinding` runs an interactive transaction, and the decider's
 * display name is read before it returns. Read through the global client, that
 * name lookup asks the pool for a second connection while the transaction holds
 * the first. With the pool exhausted (one connection here, or N concurrent
 * decisions against a pool of N in production) the lookup waits for a
 * connection only the transaction's own end can free, so the transaction runs
 * into its timeout and fails (P2028). SQLite has no pool, so the SQLite suite
 * (`governing-findings-1874.sqlite.test.ts`) passes either way.
 *
 * Here three decisions start at once on a one-connection pool. Each must
 * commit, and a fresh read through `listGoverningFindings` shows the decision
 * and the decider's name.
 *
 * Gated like the other `*-postgres.integration.test.ts` suites: runs only when
 * `RUN_INTEGRATION_TESTS=1` AND `DATABASE_URL` is Postgres-shaped.
 */
import { randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL ?? "";
const isPostgres = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://");
const enabled = process.env.RUN_INTEGRATION_TESTS === "1" && isPostgres;

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/prisma.js")>();
  return {
    ...actual,
    get prisma() {
      return state.db;
    },
  };
});

const { decideGoverningFinding, listGoverningFindings } =
  await import("../src/lib/governing/findings-store.js");

const SUFFIX = randomUUID().slice(0, 8);
const USERS = ["ada", "grace", "edsger"].map((n) => `u-2032pg-${n}-${SUFFIX}`);
const WORKSPACE = `ws-2032pg-${SUFFIX}`;
const PROJECT = `proj-2032pg-${SUFFIX}`;
const ANALYSIS = `ana-2032pg-${SUFFIX}`;
const FINDINGS = ["f1", "f2", "f3"].map((n) => `gf-2032pg-${n}-${SUFFIX}`);

describe.skipIf(!enabled)("#2032 — decisions on a one-connection pool (Postgres)", () => {
  let db: PrismaClient;

  beforeAll(async () => {
    // One pooled connection: a second checkout from inside a transaction can
    // never be served. The checkout timeout turns a wait into an error instead
    // of a hang, should the transaction's own timeout not end it first.
    db = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 15_000,
      }),
    });
    state.db = db;
    for (const id of USERS) {
      await db.user.create({
        data: { id, username: id, displayName: `Name of ${id}`, email: `${id}@example.test` },
      });
    }
    await db.workspace.create({ data: { id: WORKSPACE, name: WORKSPACE, slug: WORKSPACE } });
    await db.project.create({
      data: {
        id: PROJECT,
        name: PROJECT,
        slug: PROJECT,
        createdById: USERS[0]!,
        workspaceId: WORKSPACE,
      },
    });
    await db.analysis.create({
      data: { id: ANALYSIS, projectId: PROJECT, startedById: USERS[0]!, status: "completed" },
    });
    for (const [i, id] of FINDINGS.entries()) {
      await db.governingFinding.create({
        data: {
          id,
          analysisId: ANALYSIS,
          requirementId: "REQ-001",
          ruleId: `rule-${i}`,
          revisionId: "rev-1",
          revisionLabel: "v1",
          documentTitle: "Information Handling Policy",
          controlId: `C-${i}`,
          clauseRef: `§${i}`,
          status: "gap",
          reasoning: "Not covered.",
        },
      });
    }
  });

  afterAll(async () => {
    if (!db) return;
    await db.auditLog.deleteMany({ where: { targetId: { in: FINDINGS } } });
    await db.analysis.deleteMany({ where: { id: ANALYSIS } });
    await db.project.deleteMany({ where: { id: PROJECT } });
    await db.workspace.deleteMany({ where: { id: WORKSPACE } });
    await db.user.deleteMany({ where: { id: { in: USERS } } });
    await db.$disconnect();
  });

  it("three decisions started at once all commit, and each reads back with its decider's name", async () => {
    const started = Date.now();
    const results = await Promise.allSettled(
      FINDINGS.map((findingId, i) =>
        decideGoverningFinding({
          analysisId: ANALYSIS,
          findingId,
          decision: i % 2 === 0 ? "rejected" : "accepted",
          note: `note ${i}`,
          decidedById: USERS[i]!,
        }),
      ),
    );
    const failed = results.flatMap((r) => (r.status === "rejected" ? [String(r.reason)] : []));
    expect(failed).toEqual([]);
    // A decision that had to wait out a transaction timeout would take seconds.
    expect(Date.now() - started).toBeLessThan(4_000);

    const read = await listGoverningFindings(ANALYSIS);
    expect(
      read.map((f) => ({
        id: f.id,
        decision: f.decision,
        by: f.decidedByName,
        note: f.decisionNote,
      })),
    ).toEqual(
      FINDINGS.map((id, i) => ({
        id,
        decision: i % 2 === 0 ? "rejected" : "accepted",
        by: `Name of ${USERS[i]}`,
        note: `note ${i}`,
      })),
    );
    const audits = await db.auditLog.count({
      where: { action: "governing.finding.decision", targetId: { in: FINDINGS } },
    });
    expect(audits).toBe(3);
  });
});
