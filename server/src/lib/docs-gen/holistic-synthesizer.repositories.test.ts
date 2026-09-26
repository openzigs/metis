/** #1354: real roots, source extraction, cache and citation pipeline; only DB/LLM mocked. */
import { chmod, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn(), findFirst: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

const phase1Prompts: string[] = [];
const sectionPrompts: string[] = [];
const judgePrompts: string[] = [];
const provider: AIProvider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async (messages) => {
    const user = messages.map((m) => String(m.content)).join("\n");
    if (user.includes("SOURCE EVIDENCE")) {
      judgePrompts.push(user);
      return {
        content: JSON.stringify({
          verdicts: [{ claim: "Repository rules.", supported: true, sourceIds: [] }],
        }),
      };
    }
    return { content: JSON.stringify({ claims: [{ claim: "Repository rules.", sourceIds: [] }] }) };
  }),
  async *stream(messages): AsyncGenerator<ChatChunk> {
    const user = String(messages.at(-1)?.content);
    if (user.includes("section group now")) {
      sectionPrompts.push(user);
      const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "Section";
      yield { type: "delta", content: `## ${label}\n\nRepository rules.` };
    } else {
      phase1Prompts.push(user);
      const rule = user.includes("ALPHA_ONLY")
        ? "ALPHA_ONLY"
        : user.includes("BETA_ONLY")
          ? "BETA_ONLY"
          : "SHARED_RULE";
      yield { type: "delta", content: `PURPOSE\n- Source facts.\n\nRULES\n- ${rule}` };
    }
    yield { type: "done" };
  },
} as AIProvider;
vi.mock("../ai/index.js", () => ({
  loadAIConfig: () => ({ provider: "bedrock-gateway", model: "fixture" }),
  buildProvider: () => provider,
}));

import {
  synthesizeHolisticDocument,
  extractModuleFacts,
  preparePhase1Module,
  countPhase1Chunks,
  buildSectionFactsSources,
  type ModuleGroup,
} from "./holistic-synthesizer.js";
import {
  buildGroundingContext,
  factsSourceId,
  mergeFactsIntoContext,
} from "./grounding/grounding-context.js";
import { buildCodeGraphSummary } from "./code-graph-summary.js";
import { repositoryPathIdentity } from "./repository-identity.js";
import { phase1ChunkLimits } from "./phase1-chunking.js";
import {
  deriveDocStatus,
  SQL_FILES_SECTION,
  summarizeWarnings,
} from "./grounding/degraded-warnings.js";

let root: string;
const cache = new Map<string, Record<string, unknown>>();
const identity = (id: string) => ({ codeGraphId: `graph-${id}`, repoConnectorId: id });
const symbols = (id: string) =>
  ["class", "method", "method"].map((kind, index) => ({
    id: `${id}-${index}`,
    codeGraphId: `graph-${id}`,
    qualifiedName: `Rules${index}`,
    kind,
    filePath: "src/rules.ts",
    language: "ts",
    startLine: 1,
    endLine: 3,
  }));
async function writeRepo(id: string, body: string) {
  await mkdir(path.join(root, id, ".git"), { recursive: true });
  await mkdir(path.join(root, id, "src"), { recursive: true });
  await writeFile(path.join(root, id, ".git/HEAD"), "ref: refs/heads/main");
  await writeFile(path.join(root, id, "src/rules.ts"), body);
}
beforeEach(async () => {
  vi.clearAllMocks();
  cache.clear();
  phase1Prompts.length = sectionPrompts.length = judgePrompts.length = 0;
  root = await mkdtemp(path.join(os.tmpdir(), "metis-1354-synthesis-"));
  vi.stubEnv("REPO_CLONE_DIR", root);
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
  vi.stubEnv("AI_OFFLINE", "0");
  await writeRepo(
    "a",
    'export class Rules { check() { if (value < 11) throw new Error("ALPHA_ONLY"); } }',
  );
  await writeRepo(
    "b",
    'export class Rules { check() { if (value > 99) throw new Error("BETA_ONLY"); } }',
  );
  db.project.findUnique.mockResolvedValue({ name: "Two repositories" });
  db.codeGraph.findMany.mockImplementation(async ({ where }) =>
    ["a", "b"]
      .filter((id) => !where.id || where.id === `graph-${id}`)
      .map((id) => ({
        id: `graph-${id}`,
        repoConnection: { id, projectId: "p", deletedAt: null },
      })),
  );
  db.codeGraph.findFirst.mockImplementation(async ({ where }) => ({
    id: `graph-${where.repoConnectionId}`,
  }));
  db.codeSymbol.findMany.mockImplementation(async ({ where }) =>
    ["a", "b"]
      .filter((id) => !where.codeGraphId || where.codeGraphId === `graph-${id}`)
      .flatMap(symbols),
  );
  db.codeSymbol.groupBy.mockResolvedValue(
    ["a", "b"].map((id) => ({
      codeGraphId: `graph-${id}`,
      filePath: "src/rules.ts",
      _count: { _all: 3 },
    })),
  );
  db.codeEdge.findMany.mockResolvedValue([]);
  db.finding.findMany.mockResolvedValue([]);
  db.docsGenFactCache.findUnique.mockImplementation(
    async ({ where }) => cache.get(where.projectId_cacheKey.cacheKey) ?? null,
  );
  db.docsGenFactCache.upsert.mockImplementation(async ({ create }) => {
    cache.set(create.cacheKey, { ...create, id: create.cacheKey, createdAt: new Date() });
    return create;
  });
  db.docsGenFactCache.update.mockResolvedValue({});
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("#1354 actual multi-repository synthesis", () => {
  it("keeps same-path facts and judge citations separate through cold and warm-cache synthesis", async () => {
    const grounding = buildGroundingContext({
      ragChunks: [{ documentId: "reference", chunkId: "1", text: "Project reference." }],
    });
    await synthesizeHolisticDocument("p", "architecture", "Architecture", { grounding });
    expect(phase1Prompts).toHaveLength(2);
    const alpha = phase1Prompts.find((p) => p.includes("Module path: `a / src`"))!;
    const beta = phase1Prompts.find((p) => p.includes("Module path: `b / src`"))!;
    expect(alpha).toContain("ALPHA_ONLY");
    expect(alpha).not.toContain("BETA_ONLY");
    expect(beta).toContain("BETA_ONLY");
    expect(beta).not.toContain("ALPHA_ONLY");
    expect(cache.size).toBe(2);
    expect(db.codeSymbol.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ["codeGraphId", "filePath"] }),
    );
    expect(
      [...phase1Prompts, ...sectionPrompts, ...judgePrompts].every((p) => !p.includes(root)),
    ).toBe(true);
    for (const id of ["a", "b"]) {
      expect(sectionPrompts.some((p) => p.includes(`MODULE: ${id} / src`))).toBe(true);
      expect(
        judgePrompts.some((p) =>
          p.includes(`facts:${repositoryPathIdentity(identity(id), "src")}:`),
        ),
      ).toBe(true);
    }
    const keys = [...cache.keys()].sort();
    phase1Prompts.length = sectionPrompts.length = judgePrompts.length = 0;
    await synthesizeHolisticDocument("p", "architecture", "Architecture", { grounding });
    expect(phase1Prompts).toHaveLength(0);
    expect([...cache.keys()].sort()).toEqual(keys);
    expect(db.docsGenFactCache.update).toHaveBeenCalledTimes(2);
    expect(judgePrompts.some((p) => p.includes("ALPHA_ONLY") && p.includes("BETA_ONLY"))).toBe(
      true,
    );
  });

  it("does not share fact cache entries even when repositories have identical source bodies", async () => {
    for (const id of ["a", "b"]) {
      await writeRepo(id, "const TOTAL = value * 11;\n// ALPHA_ONLY");
    }
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    expect(phase1Prompts).toHaveLength(2);
    expect(cache.size).toBe(2);
    const prompt = sectionPrompts[0];
    expect(prompt).toMatch(/\[a\].*value/);
    expect(prompt).toMatch(/\[b\].*value/);
  });

  it("repository scope loads and reads only its selected graph, including warm cache", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture", { repoConnectorId: "b" });
    expect(phase1Prompts).toHaveLength(1);
    expect(phase1Prompts[0]).toContain("BETA_ONLY");
    expect(phase1Prompts[0]).not.toContain("ALPHA_ONLY");
    expect(db.codeGraph.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p", id: "graph-b" } }),
    );
    await synthesizeHolisticDocument("p", "architecture", "Architecture", { repoConnectorId: "b" });
    expect(phase1Prompts).toHaveLength(1);
  });

  it("missing root degrades that repository, preserves valid output and never reuses its warm cached facts", async () => {
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    await rm(path.join(root, "b"), { recursive: true });
    phase1Prompts.length = sectionPrompts.length = judgePrompts.length = 0;
    const result = await synthesizeHolisticDocument("p", "architecture", "Architecture");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ kind: "source-unavailable", section: "Repository b" }),
    );
    expect(sectionPrompts.some((p) => p.includes("ALPHA_ONLY"))).toBe(true);
    expect(sectionPrompts.every((p) => !p.includes("BETA_ONLY"))).toBe(true);
    expect(phase1Prompts.every((p) => !p.includes("ALPHA_ONLY") && !p.includes("BETA_ONLY"))).toBe(
      true,
    );
    expect(db.docsGenFactCache.upsert).toHaveBeenCalledTimes(2);
  });

  it("discovers identical SQL-only directories per repository without coalescing them", async () => {
    for (const id of ["a", "b"]) {
      await mkdir(path.join(root, id, "schema"));
      await writeFile(
        path.join(root, id, "schema/rules.sql"),
        `CREATE TABLE rules (\n  ${id}_field INT NOT NULL\n);`,
      );
    }
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    const a = phase1Prompts.find((p) => p.includes("Module path: `a / schema`"))!;
    const b = phase1Prompts.find((p) => p.includes("Module path: `b / schema`"))!;
    expect(a).toContain("a_field");
    expect(a).not.toContain("b_field");
    expect(b).toContain("b_field");
    expect(b).not.toContain("a_field");
  });

  it("reads every SQL-only directory across repositories — past the old 24-module cap", async () => {
    for (const id of ["a", "b"]) {
      for (let i = 0; i < 15; i++) {
        await mkdir(path.join(root, id, `schema${i}`));
        await writeFile(
          path.join(root, id, `schema${i}/rules.sql`),
          "CREATE TABLE bounded (id INT NOT NULL);",
        );
      }
    }
    await synthesizeHolisticDocument("p", "architecture", "Architecture");
    expect(phase1Prompts).toHaveLength(32); // two code modules + all 30 SQL modules
  });

  it("keeps repo-qualified facts collision-free at identical ranks, with matching blob and source metadata", () => {
    const facts = ["a", "b"].map((id) => ({
      repository: identity(id),
      modulePath: "src",
      moduleName: `${id} / src`,
      classCount: 1,
      methodCount: 2,
      facts: `RULES\n- ${id}`,
      formulas: [],
      topClasses: [],
    }));
    const group = { id: "architecture", label: "Architecture", instructions: "" };
    const inputs = buildSectionFactsSources(facts, group, "architecture");
    const sources = inputs.map((s) => ({ ...s, idx: 0 }));
    const context = buildGroundingContext({ factsSources: sources });
    const merged = mergeFactsIntoContext(undefined, sources);
    expect(context.sources).toHaveLength(2);
    expect(merged.sourceIds).toEqual(context.sourceIds);
    expect(context.sources[0]).toMatchObject({
      repository: identity("a"),
      evidenceClass: "repository-source",
    });
    expect(context.sourceIds).toContain(factsSourceId("src", 0, identity("b")));
    expect(factsSourceId("src:a", 0, identity("a"))).not.toBe(
      factsSourceId("src/a", 0, identity("a")),
    );
  });

  it("does not infer cross-repository lineage from identical dataset or directory names", () => {
    const summary = buildCodeGraphSummary(
      ["a", "b"].map((id) => ({
        id,
        qualifiedName: "same",
        kind: "function",
        filePath: "src/main.sas",
        repository: identity(id),
      })),
      [
        {
          kind: "references",
          fromSymbolId: "a",
          toSymbolId: null,
          toQualifiedName: "work.same",
          metadata: { lineage: "output" },
        },
        {
          kind: "references",
          fromSymbolId: "b",
          toSymbolId: null,
          toQualifiedName: "work.same",
          metadata: { lineage: "input" },
        },
        { kind: "calls", fromSymbolId: "a", toSymbolId: "b", toQualifiedName: null },
      ],
    );
    expect(summary.perModuleLineage.size).toBe(2);
    expect(summary.datasetLineage).toHaveLength(2);
    expect(
      summary.datasetLineage.every((d) => d.producers.length === 0 || d.consumers.length === 0),
    ).toBe(true);
    expect(summary.crossModuleDeps.get(repositoryPathIdentity(identity("a"), "src"))).toEqual(
      new Set([repositoryPathIdentity(identity("b"), "src")]),
    );
  });

  it.each([9, 30, 90])(
    "preserves method/line/snippet caps for a %i-symbol module",
    async (count) => {
      const lines = Array.from({ length: 400 }, (_, i) => `// line-${i} ${"x".repeat(250)}`);
      await writeFile(path.join(root, "a/src/rules.ts"), lines.join("\n"));
      const m: ModuleGroup = {
        dir: "src",
        repository: identity("a"),
        syms: Array.from({ length: count }, (_, i) => ({
          id: `s${i}`,
          qualifiedName: `method${i}`,
          kind: "method",
          filePath: "src/rules.ts",
          startLine: 1,
          endLine: 400,
        })),
      };
      const result = await extractModuleFacts(m, provider, false, "p", path.join(root, "a"));
      expect(result?.sourceUnavailable).toBe(false);
      const prompt = phase1Prompts[0];
      const snippet = /```\n([\s\S]*?)\n```/.exec(prompt)?.[1] ?? "";
      expect(snippet.length).toBeLessThanOrEqual(60_000);
      expect(snippet).not.toContain("line-301");
      expect((snippet.match(/\/\/ method/g) ?? []).length).toBe(1);
    },
  );

  it.each([10, 50, 100])("reads every one of %i short methods (no method cap)", async (count) => {
    await writeFile(
      path.join(root, "a/src/rules.ts"),
      Array.from({ length: count }, (_, i) => `return ${i};`).join("\n"),
    );
    const m: ModuleGroup = {
      dir: "src",
      repository: identity("a"),
      syms: Array.from({ length: count }, (_, i) => ({
        id: `s${i}`,
        qualifiedName: `method${i}`,
        kind: "method",
        filePath: "src/rules.ts",
        startLine: i + 1,
        endLine: i + 1,
      })),
    };
    await extractModuleFacts(m, provider, false, "p", path.join(root, "a"));
    const read = phase1Prompts.join("\n").match(/\/\/ method\d+\n/g) ?? [];
    expect(new Set(read).size).toBe(count);
  });

  describe("DOCS_GEN_PHASE1_INCLUDE_TESTS", () => {
    beforeEach(async () => {
      await writeFile(
        path.join(root, "a/src/rules.test.ts"),
        'it("x", () => { if (value > 5) throw new Error("TEST_ONLY"); });',
      );
      db.codeSymbol.findMany.mockImplementation(async ({ where }) =>
        ["a", "b"]
          .filter((id) => !where.codeGraphId || where.codeGraphId === `graph-${id}`)
          .flatMap((id) => [
            ...symbols(id),
            ...(id === "a"
              ? [
                  {
                    id: "a-test",
                    codeGraphId: "graph-a",
                    qualifiedName: "rules.test",
                    kind: "module",
                    filePath: "src/rules.test.ts",
                    language: "ts",
                    startLine: 1,
                    endLine: 1,
                  },
                ]
              : []),
          ]),
      );
    });

    it("reads test files by default (full coverage)", async () => {
      await synthesizeHolisticDocument("p", "architecture", "Architecture");
      expect(phase1Prompts.join("\n")).toContain("TEST_ONLY");
    });

    it("neither reads nor mines test files when off", async () => {
      vi.stubEnv("DOCS_GEN_PHASE1_INCLUDE_TESTS", "false");
      await synthesizeHolisticDocument("p", "architecture", "Architecture");
      const all = phase1Prompts.join("\n");
      expect(all).toContain("ALPHA_ONLY");
      expect(all).not.toContain("TEST_ONLY");
      expect(all).not.toContain("rules.test.ts");
    });
  });

  it("reports Phase-1 progress per planned chunk, from 0 to the total", async () => {
    const updates: Array<{ done: number; total: number }> = [];
    await synthesizeHolisticDocument("p", "architecture", "Architecture", {
      onPhase1Progress: (u) => updates.push(u),
    });
    // Two modules of one chunk each.
    expect(updates[0]).toEqual({ done: 0, total: 2 });
    expect(updates.map((u) => u.done)).toEqual([0, 1, 2, 2]);
    expect(updates.every((u) => u.total === 2)).toBe(true);
  });

  it("counts Phase-1 progress in chunks: a module too large for one call contributes several", async () => {
    const fns = 60;
    await writeFile(
      path.join(root, "a/src/rules.ts"),
      Array.from({ length: fns }, (_, i) =>
        [
          `export function rule${i}(v: number) {`,
          ...Array.from({ length: 18 }, (_, k) => `  const s${k} = v * ${k} + ${i};`),
          "}",
        ].join("\n"),
      ).join("\n"),
    );
    db.codeSymbol.findMany.mockImplementation(async ({ where }) =>
      ["a", "b"]
        .filter((id) => !where.codeGraphId || where.codeGraphId === `graph-${id}`)
        .flatMap((id) =>
          id === "a"
            ? Array.from({ length: fns }, (_, i) => ({
                id: `a-${i}`,
                codeGraphId: "graph-a",
                qualifiedName: `rule${i}`,
                kind: "function",
                filePath: "src/rules.ts",
                language: "ts",
                startLine: i * 20 + 1,
                endLine: i * 20 + 20,
              }))
            : symbols(id),
        ),
    );
    const updates: Array<{ done: number; total: number }> = [];
    await synthesizeHolisticDocument("p", "architecture", "Architecture", {
      onPhase1Progress: (u) => updates.push(u),
    });
    const total = updates[0].total;
    expect(total).toBeGreaterThan(2);
    // One tick per planned chunk, in order, then the end-of-phase report.
    expect(updates.map((u) => u.done)).toEqual([
      ...Array.from({ length: total + 1 }, (_, i) => i),
      total,
    ]);
    // As many chunk ticks as Phase-1 calls (no cut-offs here).
    expect(phase1Prompts).toHaveLength(total);
  });

  // chmod 000 does not stop root from listing a directory.
  it.skipIf(process.getuid?.() === 0)(
    "warns in the document when the SQL-only scan cannot read a directory",
    async () => {
      const locked = path.join(root, "a", "locked");
      await mkdir(locked);
      await writeFile(path.join(locked, "rules.sql"), "CREATE TABLE hidden (id INT NOT NULL);");
      await chmod(locked, 0o000);
      try {
        const result = await synthesizeHolisticDocument("p", "architecture", "Architecture");
        const w = result.warnings.find((x) => x.section === "SQL schema scan (a)");
        expect(w).toBeDefined();
        expect(w!.kind).toBe("source-unavailable");
        expect(w!.message).toContain("locked");
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  it("#185 — reads only the in-scope .sql files of a module when a prefix names one file", async () => {
    await mkdir(path.join(root, "a", "db"));
    await writeFile(path.join(root, "a", "db", "in.sql"), "CREATE TABLE t (id INT NOT NULL);");
    await writeFile(path.join(root, "a", "db", "sibling.sql"), "CREATE TABLE u (id INT NOT NULL);");
    const sqlFilesRead = async (prefixes?: string[] | null) =>
      (
        await preparePhase1Module({ dir: "db", syms: [] }, path.join(root, "a"), true, prefixes)
      ).units
        .filter((u) => u.inventoryOnly)
        .map((u) => u.filePath);
    expect(await sqlFilesRead(["db/in.sql"])).toEqual(["db/in.sql"]);
    // A directory prefix, or no scope, still reads every .sql file there.
    expect(await sqlFilesRead(["db"])).toEqual(["db/in.sql", "db/sibling.sql"]);
    expect(await sqlFilesRead(null)).toEqual(["db/in.sql", "db/sibling.sql"]);
    expect(await sqlFilesRead()).toEqual(["db/in.sql", "db/sibling.sql"]);
  });

  it("keeps every rule of a 150,000-constraint .sql file (no argument-spread overflow)", async () => {
    await mkdir(path.join(root, "a", "db"));
    const n = 150_000;
    await writeFile(
      path.join(root, "a", "db", "schema.sql"),
      Array.from(
        { length: n },
        (_, i) => `ALTER TABLE p ADD CONSTRAINT c${i} CHECK (a > ${i});`,
      ).join("\n"),
    );
    const prepared = await preparePhase1Module({ dir: "db", syms: [] }, path.join(root, "a"));
    const sqlUnits = prepared.units.filter((u) => u.inventoryOnly);
    expect(sqlUnits).toHaveLength(1);
    expect(sqlUnits[0].rules).toHaveLength(n);
    expect(sqlUnits[0].endLine).toBe(n);
    expect(prepared.skippedFiles).toEqual([]);
  });

  it.skipIf(process.getuid?.() === 0)(
    "names an unreadable .sql file in a document warning instead of skipping it silently",
    async () => {
      await mkdir(path.join(root, "a", "src", "sql"), { recursive: true });
      const locked = path.join(root, "a", "src", "locked.sql");
      await writeFile(locked, "CREATE TABLE t (id INT NOT NULL);");
      await chmod(locked, 0o000);
      try {
        const result = await synthesizeHolisticDocument("p", "architecture", "Architecture");
        const w = result.warnings.find(
          (x) => x.section === SQL_FILES_SECTION && x.message.includes("SQL file"),
        );
        expect(w).toBeDefined();
        expect(w!.message).toContain("src/locked.sql");
        // #191 — the advice fits a file the server cannot read.
        const summary = summarizeWarnings([w!]);
        expect(summary).toContain("check that the server can read them");
        expect(summary).not.toContain("re-ingest");
      } finally {
        await chmod(locked, 0o644);
      }
    },
  );

  // #191 (L3) — the module-directory listing no longer fails silently.
  it.skipIf(process.getuid?.() === 0)(
    "names a module directory that exists but cannot be listed, so none of its SQL is mined",
    async () => {
      await writeFile(
        path.join(root, "a", "src", "schema.sql"),
        "CREATE TABLE t (id INT NOT NULL);",
      );
      const src = path.join(root, "a", "src");
      // Traversable (so its source file is still read) but not listable.
      await chmod(src, 0o300);
      try {
        const prepared = await preparePhase1Module(
          { dir: "src", syms: symbols("a") } as unknown as ModuleGroup,
          path.join(root, "a"),
        );
        expect(prepared.fileLines.has("src/rules.ts")).toBe(true);
        expect(prepared.skippedDirectories).toEqual(["src"]);
        const result = await synthesizeHolisticDocument("p", "architecture", "Architecture");
        const w = result.warnings.find((x) => x.section === SQL_FILES_SECTION);
        expect(w).toBeDefined();
        expect(w!.message).toContain("1 module directory could not be listed");
        expect(w!.message).toContain("src");
        expect(deriveDocStatus(result.warnings)).toBe("degraded");
      } finally {
        await chmod(src, 0o755);
      }
    },
  );

  // #191 (N5) — counting chunks up front no longer holds every prepared module.
  it("counts every module's chunks but keeps only the modules extraction starts with", async () => {
    const modules = Array.from(
      { length: 5 },
      (_, i) => ({ dir: `m${i}`, syms: [] }) as ModuleGroup,
    );
    const prepare = vi.fn(async (m: ModuleGroup) => {
      if (m.dir === "m3") throw new Error("unreadable");
      return preparePhase1Module(
        { dir: "src", syms: symbols("a") } as unknown as ModuleGroup,
        path.join(root, "a"),
      );
    });
    const limits = phase1ChunkLimits(8192);
    const { prepared, chunksPlanned } = await countPhase1Chunks(modules, prepare, limits, 2);
    expect(prepare).toHaveBeenCalledTimes(5);
    // Four prepared modules of one chunk each, and one that failed (one chunk).
    expect(chunksPlanned).toBe(5);
    expect([...prepared.keys()].map((m) => m.dir)).toEqual(["m0", "m1"]);
  });

  it("stays quiet for a module directory that does not exist (a virtual module)", async () => {
    const prepared = await preparePhase1Module(
      { dir: "src/rules", syms: [] },
      path.join(root, "a"),
    );
    expect(prepared.skippedDirectories).toEqual([]);
    expect(prepared.skippedFiles).toEqual([]);
  });
});
