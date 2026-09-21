/**
 * E2E round-trip test for the provider-agnostic LOGICAL dump/reload (Path B).
 *
 * This is a CLI integration test (NOT Playwright — there is no UI). It runs in
 * the DEFAULT `pnpm test` so CI exercises the full export→import cycle on every
 * PR. It does NOT depend on a running server.
 *
 * Flow:
 *   1. Create TWO throwaway SQLite DB files in a temp dir.
 *   2. Apply the schema to each via `prisma migrate deploy` (env DATABASE_URL).
 *   3. Seed a small, representative dataset into DB #1 (a model with FK
 *      relations, a Secret row with a `ciphertext` column, a model with a Json
 *      column, DateTime columns, and a self-referential relationship to
 *      exercise the deferred-FK two-pass).
 *   4. Run `tsx scripts/logical-export.ts` against DB #1, then
 *      `tsx scripts/logical-import.ts` into DB #2 (each as a subprocess with its
 *      own DATABASE_URL).
 *   5. Assert: per-model row counts match the manifest; key FK relationships
 *      resolve in DB #2; `Secret.ciphertext` survives byte-identically; Json /
 *      DateTime values are intact; the self-referential parent link is restored.
 *
 * If applying migrations to a temp SQLite file is infeasible in the sandbox, the
 * test fails with a CLEAR message rather than silently skipping.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readGeneratedClientProvider } from "../../../tests/lib/db/generated-client-provider.js";

/**
 * Issue #876 — the ONE suite in `pnpm test` that is structurally SQLite-only.
 *
 * Everything else in the default run stubs Prisma, so it does not care which provider the
 * client was generated for. This suite does the opposite: it builds real SQLite database
 * files and constructs `PrismaClient` with `PrismaBetterSqlite3` (here, and again inside the
 * export/import CLI subprocesses, which are handed a `file:` DATABASE_URL). A
 * Postgres-generated client rejects that adapter outright — "The Driver Adapter
 * `@prisma/adapter-better-sqlite3`, based on `sqlite`, is not compatible with the provider
 * `postgres`" — and no amount of harness setup can bridge it, because the incompatibility is
 * baked into the generated artifact.
 *
 * So on a Postgres-generated client the round-trip is not asserted at all rather than
 * asserted wrongly. This costs no CI coverage: the `api` job builds the SQLite client, which
 * is the default everywhere, so the suite runs on every PR. It skips only in the local
 * dogfooding case this issue exists to unblock (dev switched to Postgres), and for the
 * `postgres-adapter` job's full-suite regression run.
 */
const describeOnSqliteClient = describe.skipIf(readGeneratedClientProvider() !== "sqlite");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");
const EXPORT_CLI = path.join(SERVER_ROOT, "scripts", "logical-export.ts");
const IMPORT_CLI = path.join(SERVER_ROOT, "scripts", "logical-import.ts");

// This suite stands up real subprocesses + THREE SQLite DBs and runs all
// migrations on each (migrate src/dst/remap) plus three `tsx` export/import CLI
// subprocesses. Under concurrent CI load on the self-hosted runner the 120s
// budget was occasionally exceeded in the `beforeAll` hook, failing the whole
// suite on a hook timeout rather than a real assertion (Issue #509). Doubling
// to 240s gives ample headroom without masking a genuine hang (a real deadlock
// still trips the limit).
const SUITE_TIMEOUT = 240_000;

function clientFor(dbFile: string): PrismaClient {
  const adapter = new PrismaBetterSqlite3({ url: `file:${dbFile}` });
  return new PrismaClient({ adapter });
}

function runCli(scriptPath: string, args: string[], dbFile: string): string {
  return execFileSync("npx", ["tsx", scriptPath, ...args], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}`, DATABASE_PROVIDER: "sqlite" },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function migrate(dbFile: string): void {
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: SERVER_ROOT,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describeOnSqliteClient("logical export/import round-trip (SQLite → SQLite)", () => {
  let tmpDir: string;
  let srcDb: string;
  let dstDb: string;
  let dumpDir: string;

  // Seeded values we assert survive the round-trip.
  const CIPHERTEXT = Buffer.from([0, 1, 254, 255, 127, 128, 42]).toString("base64");
  const WARNINGS_JSON = { items: ["a", "b"], nested: { count: 3, flag: true }, n: null };
  const GENERATED_AT = new Date("2026-03-14T15:09:26.000Z");

  let workspaceId: string;
  let userId: string;
  let projectId: string;
  let secretId: string;
  let docId: string;
  let parentReqId: string;
  let childReqId: string;
  let repoId: string;

  let remapDb: string; // third DB exercising --remap
  const OLD_API = "https://source-host.internal/api";
  const NEW_API = "https://target-host.internal/api";

  beforeAll(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "metis-logical-rt-"));
    srcDb = path.join(tmpDir, "src.db");
    dstDb = path.join(tmpDir, "dst.db");
    dumpDir = path.join(tmpDir, "dump");

    migrate(srcDb);
    migrate(dstDb);

    const src = clientFor(srcDb);
    try {
      const ws = await src.workspace.create({ data: { name: "RT WS", slug: "rt-ws" } });
      workspaceId = ws.id;

      const user = await src.user.create({
        data: { username: "rtuser", displayName: "RT User", email: "rt@example.com" },
      });
      userId = user.id;

      const project = await src.project.create({
        data: { name: "RT Project", slug: "rt-proj", workspaceId, createdById: userId },
      });
      projectId = project.id;

      const secret = await src.secret.create({
        data: {
          name: "rt-secret",
          ciphertext: CIPHERTEXT,
          iv: "rt-iv",
          tag: "rt-tag",
          salt: "rt-salt",
          keyVersion: 1,
          algorithm: "aes-256-gcm",
        },
      });
      secretId = secret.id;

      const doc = await src.generatedDocument.create({
        data: {
          projectId,
          title: "RT Doc",
          scope: "project",
          content: "# hello",
          status: "ready",
          warnings: WARNINGS_JSON,
          generatedAt: GENERATED_AT,
        },
      });
      docId = doc.id;

      // Self-referential relationship (Requirement.parent) → exercises the
      // deferred-FK two-pass on import. Requirement requires an Analysis (FK).
      const analysis = await src.analysis.create({
        data: { projectId, startedById: userId },
      });
      const parent = await src.requirement.create({
        data: { projectId, analysisId: analysis.id, title: "Parent Req", body: "p" },
      });
      parentReqId = parent.id;
      const child = await src.requirement.create({
        data: {
          projectId,
          analysisId: analysis.id,
          title: "Child Req",
          body: "c",
          parentId: parent.id,
        },
      });
      childReqId = child.id;

      // A connector row whose env-specific field (apiBaseUrl) is remapped on import.
      const repo = await src.repoConnection.create({
        data: { projectId, label: "RT Repo", apiBaseUrl: OLD_API },
      });
      repoId = repo.id;
    } finally {
      await src.$disconnect();
    }

    // Export from src, import into dst (no remap).
    runCli(EXPORT_CLI, [dumpDir], srcDb);
    runCli(IMPORT_CLI, [dumpDir], dstDb);

    // Third import into a fresh DB WITH a --remap spec, to exercise the
    // connector/env remap apply path end-to-end.
    remapDb = path.join(tmpDir, "remap.db");
    migrate(remapDb);
    const remapFile = path.join(tmpDir, "remap.json");
    writeFileSync(
      remapFile,
      JSON.stringify({
        version: 1,
        RepoConnection: { valueMap: { apiBaseUrl: { [OLD_API]: NEW_API } } },
      }),
      "utf8",
    );
    execFileSync("npx", ["tsx", IMPORT_CLI, dumpDir, "--remap", remapFile], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${remapDb}`, DATABASE_PROVIDER: "sqlite" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }, SUITE_TIMEOUT);

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a manifest with matching per-model row counts", () => {
    const manifest = JSON.parse(readFileSync(path.join(dumpDir, "logical-manifest.json"), "utf8"));
    expect(manifest.format).toBe("metis-logical-dump");
    expect(manifest.rowCounts.Workspace).toBe(1);
    expect(manifest.rowCounts.Project).toBe(1);
    expect(manifest.rowCounts.Secret).toBe(1);
    expect(manifest.rowCounts.GeneratedDocument).toBe(1);
    expect(manifest.rowCounts.Requirement).toBe(2);
    // The self-referential Requirement.parent FK must be recorded as deferred.
    expect(manifest.deferredFks.some((d: { model: string }) => d.model === "Requirement")).toBe(
      true,
    );
  });

  it("reloads every row into a fresh DB with intact counts", async () => {
    const dst = clientFor(dstDb);
    try {
      expect(await dst.workspace.count()).toBe(1);
      expect(await dst.user.count()).toBe(1);
      expect(await dst.project.count()).toBe(1);
      expect(await dst.secret.count()).toBe(1);
      expect(await dst.generatedDocument.count()).toBe(1);
      expect(await dst.requirement.count()).toBe(2);
    } finally {
      await dst.$disconnect();
    }
  });

  it("resolves FK relationships in the target DB", async () => {
    const dst = clientFor(dstDb);
    try {
      const project = await dst.project.findUniqueOrThrow({ where: { id: projectId } });
      expect(project.workspaceId).toBe(workspaceId);
      expect(project.createdById).toBe(userId);

      const doc = await dst.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      expect(doc.projectId).toBe(projectId);
    } finally {
      await dst.$disconnect();
    }
  });

  it("preserves Secret.ciphertext exactly (byte-identical base64)", async () => {
    const dst = clientFor(dstDb);
    try {
      const secret = await dst.secret.findUniqueOrThrow({ where: { id: secretId } });
      expect(secret.ciphertext).toBe(CIPHERTEXT);
      expect(secret.iv).toBe("rt-iv");
      expect(secret.keyVersion).toBe(1);
    } finally {
      await dst.$disconnect();
    }
  });

  it("preserves Json and DateTime columns", async () => {
    const dst = clientFor(dstDb);
    try {
      const doc = await dst.generatedDocument.findUniqueOrThrow({ where: { id: docId } });
      expect(doc.warnings).toEqual(WARNINGS_JSON);
      expect(doc.generatedAt?.toISOString()).toBe(GENERATED_AT.toISOString());
    } finally {
      await dst.$disconnect();
    }
  });

  it("restores the self-referential parent link via the deferred two-pass", async () => {
    const dst = clientFor(dstDb);
    try {
      const child = await dst.requirement.findUniqueOrThrow({ where: { id: childReqId } });
      expect(child.parentId).toBe(parentReqId);
      const parent = await dst.requirement.findUniqueOrThrow({ where: { id: parentReqId } });
      expect(parent.parentId).toBeNull();
    } finally {
      await dst.$disconnect();
    }
  });

  it("preserves connector rows verbatim when no --remap is given", async () => {
    const dst = clientFor(dstDb);
    try {
      const repo = await dst.repoConnection.findUniqueOrThrow({ where: { id: repoId } });
      expect(repo.apiBaseUrl).toBe(OLD_API);
    } finally {
      await dst.$disconnect();
    }
  });

  it("applies a --remap spec to rewrite an env-specific connector field", async () => {
    const remap = clientFor(remapDb);
    try {
      const repo = await remap.repoConnection.findUniqueOrThrow({ where: { id: repoId } });
      expect(repo.apiBaseUrl).toBe(NEW_API);
      // Non-remapped data is still intact in the remap target.
      expect(await remap.secret.count()).toBe(1);
      const secret = await remap.secret.findUniqueOrThrow({ where: { id: secretId } });
      expect(secret.ciphertext).toBe(CIPHERTEXT);
    } finally {
      await remap.$disconnect();
    }
  });
});

/**
 * MAJOR 2 — loud-failure paths in logical-import.ts. These craft a minimal dump
 * directory whose manifest claims rows for a model whose NDJSON file is missing,
 * and assert the import EXITS NON-ZERO instead of silently skipping. Also asserts
 * the fail-fast on an unset DATABASE_URL (no silent dev.db fallback).
 */
describeOnSqliteClient("logical import — loud failures (MAJOR 2 + DATABASE_URL fail-fast)", () => {
  let tmpDir: string;
  let db: string;

  // A minimal valid logical manifest, parameterized so each test can tweak it.
  function writeDump(
    dir: string,
    opts: {
      rowCounts: Record<string, number>;
      loadOrder: string[];
      includedModels: string[];
      deferredFks?: {
        model: string;
        fieldName: string;
        columns: string[];
        referencedModel: string;
      }[];
      files?: Record<string, string>; // ModelName -> ndjson contents
    },
  ): void {
    mkdirSync(dir, { recursive: true });
    const manifest = {
      format: "metis-logical-dump",
      version: 1,
      createdAt: new Date().toISOString(),
      provider: "sqlite",
      schemaVersion: "0.0.0",
      rowCounts: opts.rowCounts,
      includedModels: opts.includedModels,
      excludedModels: [],
      excludedFields: [],
      loadOrder: opts.loadOrder,
      deferredFks: opts.deferredFks ?? [],
    };
    writeFileSync(path.join(dir, "logical-manifest.json"), JSON.stringify(manifest), "utf8");
    for (const [model, contents] of Object.entries(opts.files ?? {})) {
      writeFileSync(path.join(dir, `${model}.ndjson`), contents, "utf8");
    }
  }

  function runImport(
    dumpDir: string,
    env: Record<string, string | undefined>,
  ): {
    code: number;
    stderr: string;
  } {
    try {
      execFileSync("npx", ["tsx", IMPORT_CLI, dumpDir], {
        cwd: SERVER_ROOT,
        env: { ...process.env, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      return { code: err.status ?? -1, stderr: err.stderr ?? "" };
    }
  }

  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "metis-logical-fail-"));
    db = path.join(tmpDir, "fail.db");
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: SERVER_ROOT,
      env: { ...process.env, DATABASE_URL: `file:${db}` },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }, SUITE_TIMEOUT);

  afterAll(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exits NON-ZERO when DATABASE_URL is unset (no silent dev.db fallback)", () => {
    const dumpDir = path.join(tmpDir, "dump-nourl");
    writeDump(dumpDir, { rowCounts: {}, loadOrder: [], includedModels: [] });
    const { code, stderr } = runImport(dumpDir, { DATABASE_URL: undefined });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/DATABASE_URL is not set/);
  });

  it("exits NON-ZERO when a Pass-1 model has a nonzero count but a MISSING ndjson file", () => {
    const dumpDir = path.join(tmpDir, "dump-missing-pass1");
    // Manifest claims 1 Workspace row but we write NO Workspace.ndjson file.
    writeDump(dumpDir, {
      rowCounts: { Workspace: 1 },
      loadOrder: ["Workspace"],
      includedModels: ["Workspace"],
      files: {},
    });
    const { code, stderr } = runImport(dumpDir, { DATABASE_URL: `file:${db}` });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/expected NDJSON file missing for Workspace/);
  });

  it("exits NON-ZERO when a DEFERRED-FK model has a nonzero count but a MISSING ndjson file", () => {
    const dumpDir = path.join(tmpDir, "dump-missing-pass2");
    // Manifest declares a deferred FK on Requirement and claims 1 row, but the
    // Requirement.ndjson file is absent → Pass 2 must fail loudly (was: silent).
    writeDump(dumpDir, {
      rowCounts: { Requirement: 1 },
      loadOrder: ["Requirement"],
      includedModels: ["Requirement"],
      deferredFks: [
        {
          model: "Requirement",
          fieldName: "parent",
          columns: ["parentId"],
          referencedModel: "Requirement",
        },
      ],
      files: {},
    });
    const { code, stderr } = runImport(dumpDir, { DATABASE_URL: `file:${db}` });
    expect(code).not.toBe(0);
    expect(stderr).toMatch(/expected NDJSON file missing for/);
  });
});
