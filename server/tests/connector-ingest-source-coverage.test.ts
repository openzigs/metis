/**
 * Issue #182 — repository-source RAG ingest coverage.
 *
 * Before #182 the ingest stopped at the first 200 files in `readdir` order,
 * skipped every file over 64 KB in silence, and wrote its only record after the
 * loop, so an interrupted run left nothing behind. These tests pin: the budget
 * (a setting, ≥ 2,000 by default), the selection order (production code →
 * configuration → tests), oversize files chunked rather than skipped, the
 * recorded outcome, and resume.
 *
 * Real files on disk; storage, knowledge service and prisma are in-memory fakes.
 */
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface FakeDoc {
  id: string;
  projectId: string;
  filename: string;
  checksum: string;
  status: string;
  indexState: string;
  chunkCount: number;
  deletedAt: null;
}

const h = vi.hoisted(() => ({
  documents: new Map<string, FakeDoc>(),
  bodies: new Map<string, string>(),
  states: [] as Array<Record<string, unknown>>,
  audits: [] as Array<{ action: string; metadata: Record<string, unknown> }>,
  warns: [] as Array<{ msg: string; meta: Record<string, unknown> }>,
  /** Per-filename override of what `ingestDocument` does. */
  onIngest: null as null | ((doc: FakeDoc) => { status: string; chunkCount: number } | void),
  ingestCalls: [] as string[],
  /** State snapshot seen at the first `ingestDocument` call. */
  stateAtFirstIngest: null as Record<string, unknown> | null,
  nextId: 0,
  inFlight: 0,
  maxInFlight: 0,
}));

vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (msg: string, meta: Record<string, unknown>) => h.warns.push({ msg, meta }),
  }),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: {
      findFirst: vi.fn(async ({ where }: { where: { projectId: string; filename: string } }) => {
        for (const d of h.documents.values()) {
          if (d.projectId === where.projectId && d.filename === where.filename) return { ...d };
        }
        return null;
      }),
      create: vi.fn(
        async ({ data }: { data: { projectId: string; filename: string; checksum: string } }) => {
          h.nextId += 1;
          const doc: FakeDoc = {
            id: `doc_${h.nextId}`,
            projectId: data.projectId,
            filename: data.filename,
            checksum: data.checksum,
            status: "pending",
            indexState: "pending",
            chunkCount: 0,
            deletedAt: null,
          };
          h.documents.set(doc.id, doc);
          return doc;
        },
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<FakeDoc> }) => {
        const doc = h.documents.get(where.id);
        if (!doc) throw new Error("missing");
        Object.assign(doc, data);
        return doc;
      }),
    },
    repoConnection: {
      update: vi.fn(async ({ data }: { data: { sourceIngestState?: string } }) => {
        if (data.sourceIngestState) h.states.push(JSON.parse(data.sourceIngestState));
        return {};
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (entry: { action: string; metadata: Record<string, unknown> }) => h.audits.push(entry),
}));

vi.mock("../src/lib/documents/storage.js", () => ({
  getDocumentStorage: () => ({
    write: vi.fn(async ({ buffer }: { buffer: Buffer }) => {
      const checksum = createHash("sha256").update(buffer).digest("hex");
      h.bodies.set(checksum, buffer.toString("utf-8"));
      return { storagePath: `blob/${checksum}`, checksum, sizeBytes: buffer.length };
    }),
  }),
}));

vi.mock("../src/lib/rag/knowledge-service.js", () => ({
  getKnowledgeService: () => ({
    ingestDocument: vi.fn(async (id: string) => {
      const doc = h.documents.get(id)!;
      if (h.ingestCalls.length === 0) h.stateAtFirstIngest = h.states.at(-1) ?? null;
      h.ingestCalls.push(doc.filename);
      h.inFlight += 1;
      h.maxInFlight = Math.max(h.maxInFlight, h.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      h.inFlight -= 1;
      const override = h.onIngest?.(doc);
      if (override) return { documentId: id, ...override };
      Object.assign(doc, { status: "ready", indexState: "indexed", chunkCount: 2 });
      return { documentId: id, status: "ready", chunkCount: 2 };
    }),
  }),
}));

import {
  DEFAULT_REPO_SOURCE_MAX_FILES,
  ingestSourceAsKnowledge,
  resolveSourceIngestLimits,
  selectSourceFiles,
  sourceTier,
} from "../src/lib/connectors/connector-ingest.js";

let root: string;

async function writeFiles(files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** Repository-relative paths of the documents created, in ingest order. */
function ingestedPaths(): string[] {
  return h.ingestCalls.map((f) => f.slice(f.indexOf(":src/") + ":src/".length));
}

const lastState = () =>
  h.states.at(-1) as Record<string, unknown> & { skipped: Record<string, number> };

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-182-")));
  h.documents.clear();
  h.bodies.clear();
  h.states.length = 0;
  h.audits.length = 0;
  h.warns.length = 0;
  h.ingestCalls.length = 0;
  h.onIngest = null;
  h.stateAtFirstIngest = null;
  h.nextId = 0;
  h.maxInFlight = 0;
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("file budget (#182 AC 1)", () => {
  it("defaults to a budget of at least 2,000 files — not the old hard-coded 200", async () => {
    expect(DEFAULT_REPO_SOURCE_MAX_FILES).toBeGreaterThanOrEqual(2000);
    const files: Record<string, string> = {};
    for (let i = 0; i < 230; i += 1) files[`src/f${String(i).padStart(3, "0")}.ts`] = `// ${i}`;
    await writeFiles(files);

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(summary.documentsCreated).toBe(230);
    expect(lastState()).toMatchObject({ status: "completed", eligible: 230, selected: 230 });
    expect(lastState().skipped.cap).toBe(0);
  });

  it("reads the budget and size ceiling from the registry, falling back on a bad value", () => {
    const values: Record<string, number | undefined> = {
      REPO_SOURCE_MAX_FILES: 12,
      REPO_SOURCE_MAX_FILE_BYTES: -5,
      REPO_SOURCE_INGEST_CONCURRENCY: 50,
    };
    const config = {
      getNumber: (key: string, fallback?: number) => values[key] ?? (fallback as number),
      getBool: (_key: string, fallback?: boolean) => fallback ?? false,
    };
    expect(resolveSourceIngestLimits(config)).toEqual({
      maxFiles: 12,
      maxFileBytes: 1024 * 1024,
      includeTests: true,
      concurrency: 8,
    });
  });

  it("counts, logs and records every file past the budget, and the run as partial", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b", "c.ts": "c", "d.ts": "d" });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { maxFiles: 3 } });

    expect(ingestedPaths()).toEqual(["a.ts", "b.ts", "c.ts"]);
    expect(lastState()).toMatchObject({ status: "partial", eligible: 4, selected: 3, created: 3 });
    expect(lastState().skipped.cap).toBe(1);
    const warn = h.warns.find((w) => w.msg.includes("REPO_SOURCE_MAX_FILES"));
    expect(warn?.meta).toMatchObject({ skipped: 1, paths: ["d.ts"] });
  });
});

describe("selection order (#182 AC 2)", () => {
  it("takes production code first, then configuration, then tests, whatever the path order", async () => {
    // The onyourleft shape: .github/ and apps/ sort before packages/, and test
    // files sit next to the code.
    await writeFiles({
      ".github/dependabot.yml": "version: 2",
      "apps/web/src/port.test.ts": "test",
      "apps/web/src/port.ts": "export const port = 1;",
      "apps/web/package.json": "{}",
      "packages/domain/src/rules.ts": "export const rule = 1;",
      "packages/domain/test/fixtures/data.json": "{}",
    });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { concurrency: 1 } });

    expect(ingestedPaths()).toEqual([
      "apps/web/src/port.ts",
      "packages/domain/src/rules.ts",
      ".github/dependabot.yml",
      "apps/web/package.json",
      "apps/web/src/port.test.ts",
      "packages/domain/test/fixtures/data.json",
    ]);
  });

  it("spends a tight budget on business code before config and tests", async () => {
    await writeFiles({
      ".github/workflows/ci.yml": "on: push",
      "apps/a.test.ts": "t",
      "packages/domain/src/fit.ts": "export const fit = 1;",
    });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { maxFiles: 1 } });

    expect(ingestedPaths()).toEqual(["packages/domain/src/fit.ts"]);
  });

  it("excludes test/spec/fixture files by policy, counted as excluded rather than skipped", async () => {
    await writeFiles({ "src/a.ts": "a", "src/a.spec.ts": "s", "__tests__/b.ts": "b" });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { includeTests: false } });

    expect(ingestedPaths()).toEqual(["src/a.ts"]);
    expect(lastState().skipped).toEqual({ cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 2 });
    // A policy exclusion is not a gap in the index.
    expect(lastState().status).toBe("completed");
  });

  it("classifies with the Phase-1 test matcher (isTestSourcePath), not a second definition", () => {
    expect(sourceTier("packages/fit/src/synthetic-test-regions.ts")).toBe("production");
    expect(sourceTier("src/ab-testing.ts")).toBe("production");
    expect(sourceTier("src/thing.test.ts")).toBe("test");
    expect(sourceTier("test-fixtures/x.ts")).toBe("test");
    expect(sourceTier("config/app.yml")).toBe("configuration");
    expect(sourceTier("src/mapper/UserMapper.xml")).toBe("configuration");
    expect(sourceTier("db/schema.sql")).toBe("production");
  });

  it("orders within a tier by path and never lets an oversize file take a budget slot", () => {
    const pick = selectSourceFiles(
      [
        { absPath: "/r/z.ts", relPath: "z.ts", sizeBytes: 10 },
        { absPath: "/r/big.ts", relPath: "big.ts", sizeBytes: 5000 },
        { absPath: "/r/a.ts", relPath: "a.ts", sizeBytes: 10 },
      ],
      { maxFiles: 2, maxFileBytes: 1000, includeTests: true },
    );
    expect(pick.selected.map((f) => f.relPath)).toEqual(["a.ts", "z.ts"]);
    expect(pick.tooLarge.map((f) => f.relPath)).toEqual(["big.ts"]);
    expect(pick.overCap).toEqual([]);
  });
});

describe("throughput (#182 AC 6)", () => {
  it("defaults to one file at a time", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    expect(h.maxInFlight).toBe(1);
  });

  it("with REPO_SOURCE_INGEST_CONCURRENCY > 1, overlaps files up to the limit and ingests each once", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 9; i += 1) files[`src/f${i}.ts`] = `// ${i}`;
    await writeFiles(files);

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { concurrency: 3 } });

    expect(h.maxInFlight).toBe(3);
    expect([...ingestedPaths()].sort()).toEqual(Object.keys(files).sort());
    expect(lastState()).toMatchObject({ processed: 9, created: 9 });
  });
});

describe("oversize files (#182 AC 3)", () => {
  it("indexes a file over the old 64 KB limit whole, for the chunker to split", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    expect(Buffer.byteLength(big)).toBeGreaterThan(64 * 1024);
    await writeFiles({ "src/generated-rules.ts": big });

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(summary.documentsCreated).toBe(1);
    const doc = [...h.documents.values()][0]!;
    const body = h.bodies.get(doc.checksum)!;
    expect(body).toContain("export const v0 = 0;");
    expect(body).toContain("export const v3999 = 3999;");
    expect(lastState()).toMatchObject({ status: "completed" });
  });

  it("skips a file over the hard ceiling, logs it by path and records the run as partial", async () => {
    await writeFiles({ "src/ok.ts": "ok", "vendor/bundle.js": "x".repeat(5000) });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { maxFileBytes: 4096 } });

    expect(ingestedPaths()).toEqual(["src/ok.ts"]);
    expect(lastState().skipped.tooLarge).toBe(1);
    expect(lastState().status).toBe("partial");
    const warn = h.warns.find((w) => w.msg.includes("REPO_SOURCE_MAX_FILE_BYTES"));
    expect(warn?.meta).toMatchObject({ path: "vendor/bundle.js", sizeBytes: 5000 });
  });
});

describe("recorded progress and outcome (#182 AC 4)", () => {
  it("records a running state before the first file is embedded", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b" });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    // An ingest that dies after this point leaves `running` behind, which a
    // reader reports as interrupted once the heartbeat goes stale.
    expect(h.stateAtFirstIngest).toMatchObject({ status: "running", eligible: 2, selected: 2 });
    // The very first write precedes even the walk, so a run that dies while
    // walking a huge tree is visible too.
    expect(h.states[0]).toMatchObject({ status: "running", finishedAt: null, eligible: 0 });
    expect(h.audits.map((a) => a.action)).toEqual([
      "connector.repo.source-ingest.started",
      "connector.repo.source-ingest",
    ]);
  });

  it("settles a finished run with its counts", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b" });

    await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(lastState()).toMatchObject({
      status: "completed",
      eligible: 2,
      selected: 2,
      processed: 2,
      created: 2,
      failed: 0,
      chunkCount: 4,
    });
    expect(lastState().finishedAt).toEqual(expect.any(String));
    expect(h.audits.at(-1)?.metadata).toMatchObject({ status: "completed", indexed: 2 });
  });

  it("records embedding failures and marks the run partial", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b" });
    h.onIngest = (doc) =>
      doc.filename.endsWith("src/b.ts") ? { status: "failed", chunkCount: 0 } : undefined;

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(summary.failures).toBe(1);
    expect(lastState()).toMatchObject({ status: "partial", failed: 1 });
  });

  it("records a run that throws as failed, then rethrows", async () => {
    await expect(
      ingestSourceAsKnowledge("p1", "c1", "u1", path.join(root, "does-not-exist")),
    ).rejects.toThrow();
    expect(lastState()).toMatchObject({ status: "failed" });
    expect(lastState().error).toEqual(expect.any(String));
    expect(h.audits.at(-1)?.metadata).toMatchObject({ status: "failed" });
  });
});

describe("skipped-file accounting", () => {
  it.skipIf(process.getuid?.() === 0)(
    "counts a file it cannot read as unreadable and records the run as partial",
    async () => {
      await writeFiles({ "a.ts": "a", "locked.ts": "secret" });
      await fs.chmod(path.join(root, "locked.ts"), 0o000);

      await ingestSourceAsKnowledge("p1", "c1", "u1", root);

      expect(ingestedPaths()).toEqual(["a.ts"]);
      expect(lastState()).toMatchObject({ status: "partial", processed: 2 });
      expect(lastState().skipped.unreadable).toBe(1);
      expect(h.warns.some((w) => w.msg.includes("unreadable") && w.meta.path === "locked.ts")).toBe(
        true,
      );
    },
  );

  it("lists at most 20 over-budget paths in the log, then summarises the rest", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 26; i += 1) files[`f${String(i).padStart(2, "0")}.ts`] = `// ${i}`;
    await writeFiles(files);

    await ingestSourceAsKnowledge("p1", "c1", "u1", root, { limits: { maxFiles: 1 } });

    const paths = h.warns.find((w) => w.msg.includes("REPO_SOURCE_MAX_FILES"))?.meta
      .paths as string[];
    expect(paths).toHaveLength(21);
    expect(paths[0]).toBe("f01.ts");
    expect(paths[20]).toBe("… and 5 more");
  });
});

describe("resume (#182 AC 4)", () => {
  it("re-running a sync skips indexed files and repairs one left processing", async () => {
    await writeFiles({ "a.ts": "a", "b.ts": "b", "c.ts": "c" });
    // First run: the process "dies" mid-embed of b.ts, leaving it the way
    // onyourleft's 174th document was left — processing / quarantined.
    h.onIngest = (doc) => {
      if (!doc.filename.endsWith("src/b.ts")) return undefined;
      Object.assign(doc, { status: "processing", indexState: "quarantined" });
      return { status: "pending", chunkCount: 0 };
    };
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    expect(h.documents.size).toBe(3);

    h.onIngest = null;
    h.ingestCalls.length = 0;
    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(ingestedPaths()).toEqual(["b.ts"]);
    expect(summary).toMatchObject({ documentsCreated: 0, documentsUpdated: 1 });
    const b = [...h.documents.values()].find((d) => d.filename.endsWith("src/b.ts"))!;
    expect(b).toMatchObject({ status: "ready", indexState: "indexed" });
    expect(lastState()).toMatchObject({ status: "completed", unchanged: 2, updated: 1 });
  });

  it("re-embeds a file whose content changed", async () => {
    await writeFiles({ "a.ts": "one" });
    await ingestSourceAsKnowledge("p1", "c1", "u1", root);
    await writeFiles({ "a.ts": "two" });
    h.ingestCalls.length = 0;

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root);

    expect(ingestedPaths()).toEqual(["a.ts"]);
    expect(summary.documentsUpdated).toBe(1);
  });
});

describe("boundary (#288) is preserved", () => {
  it("never ingests a symlinked file, inside or outside the boundary", async () => {
    await writeFiles({ "src/a.ts": "a" });
    const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-182-out-")));
    try {
      await fs.writeFile(path.join(outside, "secret.ts"), "leak");
      await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src", "secret.ts"));
      await fs.symlink(path.join(root, "src", "a.ts"), path.join(root, "src", "alias.ts"));

      await ingestSourceAsKnowledge("p1", "c1", "u1", root, { boundary: root });
      await ingestSourceAsKnowledge("p1", "c1", "u1", root);

      expect(new Set(ingestedPaths())).toEqual(new Set(["src/a.ts"]));
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

/**
 * PR #209 review — the test above passes with or without `boundary`, because a
 * symlinked entry is never yielded by the walk (`Dirent.isFile()` is false for a
 * link). These tests pin the `local` provider's realpath boundary itself through
 * the #182 candidate-collection path, and prove the outside content is never read.
 */
describe("local-source realpath boundary through candidate collection (#288, #182)", () => {
  const SECRET = "export const secret = 'LEAKED-OUTSIDE-BOUNDARY';\n";
  let outside: string;

  beforeEach(async () => {
    outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "metis-182-out-")));
    await fs.mkdir(path.join(outside, "pkg"), { recursive: true });
    await fs.writeFile(path.join(outside, "secret.ts"), SECRET);
    await fs.writeFile(path.join(outside, "pkg", "nested.ts"), SECRET);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(outside, { recursive: true, force: true });
  });

  /** Every path `fs.readFile` was asked for during the run. */
  function spyReads(): () => string[] {
    const spy = vi.spyOn(fs, "readFile");
    return () => spy.mock.calls.map((c) => String(c[0]));
  }

  function expectOutsideUntouched(reads: string[]): void {
    expect(reads.filter((p) => p.startsWith(outside) || p.includes("secret"))).toEqual([]);
    expect([...h.bodies.values()].some((b) => b.includes("LEAKED-OUTSIDE-BOUNDARY"))).toBe(false);
    expect(ingestedPaths().some((p) => p.includes("secret") || p.includes("nested"))).toBe(false);
  }

  it("a symlinked file and a symlinked directory escaping the root are neither selected nor read; a normal file is indexed", async () => {
    await writeFiles({ "src/a.ts": "export const a = 1;\n" });
    await fs.symlink(path.join(outside, "secret.ts"), path.join(root, "src", "secret.ts")); // (a)
    await fs.symlink(path.join(outside, "pkg"), path.join(root, "linked-pkg")); // (b)
    const reads = spyReads();

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", root, { boundary: root });

    expect(ingestedPaths()).toEqual(["src/a.ts"]); // (c)
    expect(summary.documentsCreated).toBe(1);
    expect(reads()).toContain(path.join(root, "src", "a.ts"));
    // Dropped by the walk itself: never eligible, so never counted as a skip.
    expect(lastState()).toMatchObject({ status: "completed", eligible: 1, selected: 1 });
    expect(lastState().skipped).toEqual({ cap: 0, tooLarge: 0, unreadable: 0, excludedTests: 0 });
    expectOutsideUntouched(reads());
  });

  it("a validated root later swapped for a symlink to elsewhere yields nothing — only the realpath boundary catches this", async () => {
    // `resolveIngestSource` validates the local path and passes its realpath as
    // both the walk root and the boundary. If that directory is then replaced by
    // a symlink, `readdir` follows it and every entry is a REGULAR file outside
    // the boundary: the Dirent type check cannot tell, the realpath check can.
    const validated = path.join(root, "checkout");
    await writeFiles({ "checkout/a.ts": "export const a = 1;\n" });
    await fs.rename(validated, path.join(root, "checkout.orig"));
    await fs.symlink(outside, validated);
    const reads = spyReads();

    const summary = await ingestSourceAsKnowledge("p1", "c1", "u1", validated, {
      boundary: validated,
    });

    expect(ingestedPaths()).toEqual([]);
    expect(summary.documentsCreated).toBe(0);
    expect(lastState()).toMatchObject({ eligible: 0, selected: 0 });
    expectOutsideUntouched(reads());
  });
});
