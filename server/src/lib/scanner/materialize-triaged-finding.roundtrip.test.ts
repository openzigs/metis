/**
 * Issue #1330 — approved triage, end to end against a REAL database.
 *
 * ## Why a real client, when the unit suite stubs Prisma everywhere else
 *
 * The bug this covers was a WRITE THAT REPORTED SUCCESS AND PERSISTED NOTHING,
 * and every guard that could have caught it was made of the same material as
 * the bug: a `vi.fn()` create that resolved for any payload, a cast that
 * erased the generated types, and a `return { findingId: undefined }` that
 * reported success when it could not write. Two of those are now fixed by a
 * `satisfies` (compile time) and a schema-derived fake (unit time). This suite
 * closes the third gap — it is the only place that proves a row LANDS and can
 * be READ BACK through the same path a consumer uses.
 *
 * It also exercises the hand-written SQLite migration that made
 * `findings.agentResultId` nullable: the temp database is built by
 * `prisma migrate deploy` over the real migration chain, so a migration that
 * does not apply fails here rather than in `postgres-migrate-deploy`.
 *
 * SQLite-only, for the reason documented at length in
 * `src/lib/portability/logical-roundtrip.test.ts`: a Postgres-generated client
 * rejects the better-sqlite3 adapter outright. The `api` CI job builds the
 * SQLite client, so this runs on every PR.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "../../../tests/lib/db/generated-client-provider.js";
import { applyTriageDecision, type ScanFindingForTriage } from "./triage-service.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const describeOnSqliteClient = describe.skipIf(readGeneratedClientProvider() !== "sqlite");

let tmpDir: string;
let db: PrismaClient;

// The module under test reaches Prisma through `../prisma.js`, which binds its
// adapter at module load from `DATABASE_URL`. Point it at the temp database.
vi.mock("../prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return { prisma: db, Prisma };
});

describeOnSqliteClient("materializeTriagedFinding against a real SQLite database", () => {
  let materializeTriagedFinding: typeof import("./prisma-adapter.js").materializeTriagedFinding;
  const ids = {
    user: "u-1330",
    project: "p-1330",
    repo: "r-1330",
    graph: "g-1330",
    symbol: "s-1330",
    scan: "sc-1330",
    scanFinding: "sf-1330",
  };

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "metis-1330-"));
    const dbFile = path.join(tmpDir, "triage.db");
    execFileSync(
      process.execPath,
      [
        path.join(SERVER_ROOT, "node_modules", "prisma", "build", "index.js"),
        "migrate",
        "deploy",
        "--schema",
        path.join(SERVER_ROOT, "prisma", "schema.prisma"),
      ],
      { cwd: SERVER_ROOT, env: { ...process.env, DATABASE_URL: `file:${dbFile}` }, stdio: "pipe" },
    );
    db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: `file:${dbFile}` }) });

    await db.user.create({
      data: {
        id: ids.user,
        username: "triager",
        displayName: "Triager",
        email: "triager@example.test",
      },
    });
    await db.project.create({
      data: { id: ids.project, name: "P", slug: "p-1330", createdById: ids.user },
    });
    await db.repoConnection.create({
      data: { id: ids.repo, projectId: ids.project, label: "repo" },
    });
    await db.codeGraph.create({ data: { id: ids.graph, projectId: ids.project } });
    await db.codeSymbol.create({
      data: {
        id: ids.symbol,
        codeGraphId: ids.graph,
        projectId: ids.project,
        kind: "function",
        name: "handler",
        qualifiedName: "src/a.ts::handler",
        filePath: "src/a.ts",
        startLine: 10,
        endLine: 42,
        language: "ts",
        contentHash: "hash",
      },
    });
    await db.scan.create({
      data: {
        id: ids.scan,
        projectId: ids.project,
        repoConnectionId: ids.repo,
        commitSha: "abc123",
        createdById: ids.user,
      },
    });
    await db.scanFinding.create({
      data: {
        id: ids.scanFinding,
        scanId: ids.scan,
        symbolId: ids.symbol,
        fingerprint: "fp-1330",
        title: "Unvalidated redirect",
        body: "The handler redirects to a user-supplied URL.",
        severity: "high",
        category: "security",
        evidenceLines: "[12,18]",
        confidence: 0.83,
      },
    });

    ({ materializeTriagedFinding } = await import("./prisma-adapter.js"));
  }, 120_000);

  afterAll(async () => {
    await db?.$disconnect();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists a Finding row that can be READ BACK, with the scan-finding back-link", async () => {
    const row = await db.scanFinding.findUniqueOrThrow({
      where: { id: ids.scanFinding },
      include: { symbol: { select: { qualifiedName: true, filePath: true } } },
    });
    const sf: ScanFindingForTriage = {
      id: row.id,
      scanId: row.scanId,
      projectId: ids.project,
      repoConnectionId: ids.repo,
      symbolId: row.symbolId,
      qualifiedName: row.symbol.qualifiedName,
      ruleId: row.ruleId,
      title: row.title,
      body: row.body,
      severity: "high",
      category: row.category,
      evidenceLines: JSON.parse(row.evidenceLines) as number[],
      filePath: row.symbol.filePath,
      fingerprint: row.fingerprint,
      confidence: row.confidence,
      triageStatus: "pending",
      materializedFindingId: row.materializedFindingId,
    };
    // Exactly what routes/triage.ts computes and threads through.
    const outcome = applyTriageDecision(sf, {
      scanFindingId: ids.scanFinding,
      decision: "approved",
      actorId: ids.user,
      note: "confirmed by review",
    });

    const result = await materializeTriagedFinding({
      scanFindingId: ids.scanFinding,
      triagedById: ids.user,
      triageStatus: outcome.newStatus,
      triageNote: "confirmed by review",
      materialised: outcome.materialised,
    });

    // The route returns this to the client as `materializedFindingId`.
    expect(result.findingId).toBeTruthy();

    // READ BACK through a fresh query, not through the object just returned.
    const finding = await db.finding.findUniqueOrThrow({
      where: { id: result.findingId as string },
    });
    expect(finding.agentResultId).toBeNull();
    expect(finding.scanFindingId).toBe(ids.scanFinding);
    expect(finding.title).toBe("Unvalidated redirect");
    expect(finding.body).toBe("The handler redirects to a user-supplied URL.");
    expect(finding.severity).toBe("high");
    expect(finding.category).toBe("security");
    expect(finding.derivation).toBe("inferred");
    expect(finding.confidence).toBeCloseTo(0.83, 5);
    expect(finding.symbolId).toBe(ids.symbol);
    expect(JSON.parse(finding.evidence as string).citations).toEqual([
      { filePath: "src/a.ts", startLine: 12, endLine: 18, symbolId: ids.symbol },
    ]);

    // The triage stamp survived — in #1330 the create threw inside the
    // transaction and the rollback destroyed the reviewer's decision.
    const stamped = await db.scanFinding.findUniqueOrThrow({ where: { id: ids.scanFinding } });
    expect(stamped.triageStatus).toBe("approved");
    expect(stamped.triageNote).toBe("confirmed by review");
    expect(stamped.triagedById).toBe(ids.user);
    expect(stamped.materializedFindingId).toBe(result.findingId);

    // The `@unique` back-relation resolves in the other direction too.
    const viaRelation = await db.scanFinding.findUniqueOrThrow({
      where: { id: ids.scanFinding },
      include: { finding: { select: { id: true } } },
    });
    expect(viaRelation.finding?.id).toBe(result.findingId);
  });

  it("is idempotent — a second approval returns the same row and creates no duplicate", async () => {
    const before = await db.finding.count();
    const result = await materializeTriagedFinding({
      scanFindingId: ids.scanFinding,
      triagedById: ids.user,
      triageStatus: "approved",
      materialised: {
        projectId: ids.project,
        symbolId: ids.symbol,
        title: "Unvalidated redirect",
        body: "b",
        severity: "high",
        category: "security",
        evidenceLines: [12, 18],
        filePath: "src/a.ts",
        scanFindingId: ids.scanFinding,
        derivation: "inferred",
        confidence: 0.83,
      },
    });
    const existing = await db.scanFinding.findUniqueOrThrow({ where: { id: ids.scanFinding } });
    expect(result.findingId).toBe(existing.materializedFindingId);
    expect(await db.finding.count()).toBe(before);
  });
});
