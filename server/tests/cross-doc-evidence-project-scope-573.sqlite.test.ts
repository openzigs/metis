/**
 * #573 — `readCrossDocFindings` resolves each evidence citation's document row
 * (filename + `documents.source`) with a lookup scoped to the analysis's project
 * (`project.analyses.some.id`). Run against a REAL SQLite built by the real
 * migration chain, so the relation filter means what it does in production: a
 * document id from ANOTHER project never resolves, while the same project's does.
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
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { readCrossDocFindings } = await import("../src/lib/analysis/analysis-service.js");

const USER = "u-573";
const PROJ = "proj-573-own";
const OTHER = "proj-573-other";
const ANALYSIS = "an-573";
const OWN_DOC = "doc-573-own";
const OTHER_DOC = "doc-573-other";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#573 — cross-doc evidence resolves only the analysis's own project's documents (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("573-crossdoc-scope");
      sqlite.exec(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES (?, ?, 'U', 'u573@example.test', 0, 0)`,
        [USER, USER],
      );
      for (const id of [PROJ, OTHER]) {
        sqlite.exec(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt)
           VALUES (?, ?, ?, ?, 0, 0)`,
          [id, id, id, USER],
        );
      }
      // [id, projectId, filename, source]
      for (const [id, projectId, filename, source] of [
        [OWN_DOC, PROJ, "connector:repo:c1:src/own.ts", "repo"],
        [OTHER_DOC, OTHER, "connector:repo:c9:src/other.ts", "repo"],
      ] as const) {
        sqlite.exec(
          `INSERT INTO documents (id, projectId, filename, source, mimeType, sizeBytes,
             storagePath, checksum, uploadedById, uploadedAt)
           VALUES (?, ?, ?, ?, 'text/markdown', 1, 'p', ?, ?, 0)`,
          [id, projectId, filename, source, `c-${id}`, USER],
        );
      }
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;

      await db.analysis.create({
        data: { id: ANALYSIS, projectId: PROJ, startedById: USER, status: "completed" },
      });
      const agentResult = await db.agentResult.create({
        data: { analysisId: ANALYSIS, agentKey: "document", status: "completed" },
      });
      // Citations with NO inline filename: the label comes only from the row
      // lookup, so an unresolved row omits the evidence ref entirely.
      const finding = (id: string, documentId: string) =>
        db.finding.create({
          data: {
            id,
            agentResultId: agentResult.id,
            category: "compliance",
            severity: "medium",
            title: id,
            body: "b",
            evidence: JSON.stringify({ citations: [{ documentId, chunkIndex: 0 }] }),
          },
        });
      await finding("fnd-own", OWN_DOC);
      await finding("fnd-other", OTHER_DOC);
      // An inline filename on a cross-project citation: the ref survives on the
      // inline name, but must not be stamped with the foreign row's source.
      await db.finding.create({
        data: {
          id: "fnd-other-named",
          agentResultId: agentResult.id,
          category: "compliance",
          severity: "medium",
          title: "fnd-other-named",
          body: "b",
          evidence: JSON.stringify({
            citations: [{ documentId: OTHER_DOC, chunkIndex: 0, filename: "other.ts" }],
          }),
        },
      });
      await db.crossDocFinding.create({
        data: {
          analysisId: ANALYSIS,
          kind: "contradiction",
          severity: "high",
          title: "t",
          detail: "d",
          evidenceIds: JSON.stringify(["fnd-own", "fnd-other", "fnd-other-named"]),
        },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("resolves the same project's document with its filename and stored source", async () => {
      const bundle = await readCrossDocFindings(ANALYSIS);
      const own = bundle!.findings[0]!.evidence!.find((e) => e.chunkId === "fnd-own");
      expect(own).toMatchObject({
        sourceLabel: "connector:repo:c1:src/own.ts",
        sourceId: OWN_DOC,
        source: "repo",
      });
    });

    it("never resolves a document that belongs to another project", async () => {
      const bundle = await readCrossDocFindings(ANALYSIS);
      const evidence = bundle!.findings[0]!.evidence!;
      // No inline name and no in-scope row ⇒ no ref (the foreign filename never leaks).
      expect(evidence.find((e) => e.chunkId === "fnd-other")).toBeUndefined();
      expect(JSON.stringify(evidence)).not.toContain("src/other.ts");
      // Inline name keeps the ref, but the foreign row's source is not applied.
      const named = evidence.find((e) => e.chunkId === "fnd-other-named");
      expect(named?.sourceLabel).toBe("other.ts");
      expect(named?.source).toBeUndefined();
    });
  },
);
