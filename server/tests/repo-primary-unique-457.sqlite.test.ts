/**
 * Issue #457 — at most one live primary repository per project, against a REAL
 * SQLite database built by the real migration chain.
 *
 * The mocked service suites prove the insert-and-retry logic; only a real
 * database proves the partial unique index exists, that it ignores non-primary
 * and soft-deleted rows, that the migration demotes pre-existing extra
 * primaries instead of failing on them, and that two concurrent first creates
 * leave exactly one primary when every write goes through the production code.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
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
vi.mock("../src/lib/vault/vault-service.js", () => ({ getVaultService: vi.fn() }));

const { createRepoConnector, createUploadRepoConnector } =
  await import("../src/lib/connectors/repo/repo-service.js");

const MIGRATION = "20261003000457_issue457_repo_primary_unique";
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";

/**
 * A client whose `repoConnection.count` holds every caller until `n` callers
 * have counted — so `n` concurrent creates all read the same (empty) project
 * before any of them inserts. The race, made deterministic.
 */
function countBarrier(db: PrismaClient, n: number): PrismaClient {
  let arrived = 0;
  let release!: () => void;
  const allCounted = new Promise<void>((r) => (release = r));
  const repo = db.repoConnection;
  const racingRepo = new Proxy(repo, {
    get(target, prop) {
      if (prop === "count") {
        return async (args: Parameters<typeof repo.count>[0]) => {
          const result = await target.count(args);
          arrived += 1;
          if (arrived === n) release();
          await allCounted;
          return result;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "repoConnection") return racingRepo;
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function zipBuf(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("src/main.ts", "export const main = 1;\n");
  return zip.generateAsync({ type: "nodebuffer" });
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#457 — repo_connections holds at most one live primary per project (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let tmp: string;

    beforeAll(async () => {
      tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-457-")));
      process.env.UPLOAD_EXTRACT_DIR = path.join(tmp, "extracts");
      process.env.UPLOAD_ARCHIVE_DIR = path.join(tmp, "archives");

      sqlite = createMigratedSqlite("457-primary", { stopBefore: MIGRATION });
      const x = sqlite.exec;
      x(
        `INSERT INTO users (id, username, displayName, email, createdAt, updatedAt)
         VALUES ('u1','u1','U1','u1@example.test',?,?)`,
        [T0, T0],
      );
      for (const p of ["p1", "p2", "p3", "p4", "p5"]) {
        x(
          `INSERT INTO projects (id, name, slug, createdById, createdAt, updatedAt)
           VALUES (?, 'Apollo', ?, 'u1', ?, ?)`,
          [p, `slug-${p}`, T0, T0],
        );
      }
      const repo = (
        id: string,
        project: string,
        isPrimary: boolean,
        createdAt: string,
        deletedAt: string | null = null,
      ) =>
        x(
          `INSERT INTO repo_connections (id, projectId, label, isPrimary, createdAt, updatedAt, deletedAt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [id, project, id, isPrimary ? 1 : 0, createdAt, createdAt, deletedAt],
        );
      // p1 holds three live primaries (the pre-#457 race): the oldest, then
      // lowest id, keeps the flag.
      repo("r_new", "p1", true, T1);
      repo("r_old_b", "p1", true, T0);
      repo("r_old_a", "p1", true, T0);
      repo("r_plain", "p1", false, T0);
      repo("r_gone", "p1", true, T0, T0);
      // p4's single primary is not a duplicate.
      repo("r_solo", "p4", true, T1);
      sqlite.apply(MIGRATION);
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      await fs.rm(tmp, { recursive: true, force: true });
      delete process.env.UPLOAD_EXTRACT_DIR;
      delete process.env.UPLOAD_ARCHIVE_DIR;
    });

    const primaries = async (projectId: string) =>
      (
        await db.repoConnection.findMany({
          where: { projectId, isPrimary: true, deletedAt: null },
          orderBy: { id: "asc" },
        })
      ).map((r) => r.id);

    it("demotes pre-existing extra primaries, keeping the oldest (then lowest id)", async () => {
      expect(await primaries("p1")).toEqual(["r_old_a"]);
      expect(await primaries("p4")).toEqual(["r_solo"]);
      // A soft-deleted row is outside the index and left untouched.
      const gone = await db.repoConnection.findUniqueOrThrow({ where: { id: "r_gone" } });
      expect(gone.isPrimary).toBe(true);
    });

    it("rejects a second live primary, but not a non-primary or a soft-deleted one", async () => {
      await expect(
        db.repoConnection.create({ data: { projectId: "p1", label: "dup", isPrimary: true } }),
      ).rejects.toMatchObject({ code: "P2002" });
      await db.repoConnection.create({
        data: { projectId: "p1", label: "gone2", isPrimary: true, deletedAt: new Date() },
      });
      await db.repoConnection.create({ data: { projectId: "p1", label: "plain2" } });
      expect(await primaries("p1")).toEqual(["r_old_a"]);
    });

    it("gives two concurrent first git/local creates exactly one primary", async () => {
      state.db = countBarrier(db, 2);
      try {
        const created = await Promise.all(
          ["a", "b"].map((label) =>
            createRepoConnector("p2", { label, ownerOrOrg: "o", repoName: label }, "u1"),
          ),
        );
        expect(created.map((c) => c.isPrimary).sort()).toEqual([false, true]);
      } finally {
        state.db = db;
      }
      const rows = await db.repoConnection.findMany({ where: { projectId: "p2" } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
    });

    it("gives two concurrent first uploads exactly one primary", async () => {
      const buf = await zipBuf();
      state.db = countBarrier(db, 2);
      try {
        const created = await Promise.all(
          ["a", "b"].map((label) => createUploadRepoConnector("p3", label, buf, "u1")),
        );
        expect(created.map((c) => c.isPrimary).sort()).toEqual([false, true]);
      } finally {
        state.db = db;
      }
      const rows = await db.repoConnection.findMany({ where: { projectId: "p3" } });
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.isPrimary)).toHaveLength(1);
      expect(rows.every((r) => r.uploadPath)).toBe(true);
    });

    it("still marks a lone first repository primary and later ones not", async () => {
      const first = await createRepoConnector(
        "p5",
        { label: "one", ownerOrOrg: "o", repoName: "one" },
        "u1",
      );
      const second = await createUploadRepoConnector("p5", "two", await zipBuf(), "u1");
      expect(first.isPrimary).toBe(true);
      expect(second.isPrimary).toBe(false);
      expect(await primaries("p5")).toEqual([first.id]);
    });
  },
);
