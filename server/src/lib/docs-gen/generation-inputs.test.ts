import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EvidencePolicy } from "./evidence-policy.js";
import { captureGenerationInputs } from "./generation-inputs.js";

const mocks = vi.hoisted(() => ({
  symbols: vi.fn(),
  edges: vi.fn(),
  chunks: vi.fn(),
  project: vi.fn(),
  findings: vi.fn(),
  repositories: vi.fn(),
  filter: vi.fn(),
  config: vi.fn(),
  phase1: vi.fn(),
  router: vi.fn(),
  web: vi.fn(),
  read: vi.fn(),
  list: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: mocks.symbols },
    codeEdge: { findMany: mocks.edges },
    knowledgeChunk: { findMany: mocks.chunks },
    project: { findFirst: mocks.project },
    finding: { findMany: mocks.findings },
  },
}));
vi.mock("../ai/config.js", () => ({ loadAIConfig: mocks.config }));
vi.mock("./holistic-synthesizer.js", () => ({
  PHASE1_PROMPT_VERSION: 3,
  buildDocsGenProvider: mocks.phase1,
  resolvePhase2Router: mocks.router,
}));
vi.mock("./output-caps.js", () => ({
  resolveFactsMaxOutputTokens: () => 4096,
  resolveSectionMaxOutputTokens: () => 8192,
}));
vi.mock("./grounding/grounding-retrieval.js", () => ({ resolveGroundingK: () => 80 }));
vi.mock("./evidence-filter.js", () => ({ filterPrimaryEvidence: mocks.filter }));
vi.mock("../analysis/analysis-service.js", () => ({ getLatestWebResearch: mocks.web }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return {
    ...fs,
    readFile: mocks.read.mockImplementation(fs.readFile),
    readdir: mocks.list.mockImplementation(fs.readdir),
  };
});
vi.mock("./repository-sources.js", async (original) => {
  const sources = await original<typeof import("./repository-sources.js")>();
  return {
    ...sources,
    loadRepositorySources: mocks.repositories,
    resolveSourcePath: mocks.resolve.mockImplementation(sources.resolveSourcePath),
  };
});

const doc = {
  projectId: "p",
  title: "Overview",
  docType: "architecture",
  scope: "repository",
  scopeFilter: '{"repoConnectorId":"a"}',
  evidencePolicy: '{"version":1,"allowWebResearch":false}',
};
const policy: EvidencePolicy = {
  projectId: "p",
  generatedDocumentId: "doc",
  actor: { userId: "u", role: "admin" },
  repoConnectorId: "a",
  codeGraphId: "g",
  sharedDocumentIds: [],
  allowWebResearch: false,
};
const symbol = (overrides = {}) => ({
  id: "s",
  codeGraphId: "g",
  projectId: "p",
  name: "run",
  qualifiedName: "M.run",
  filePath: "src/mod.ts",
  kind: "function",
  startLine: 1,
  endLine: 2,
  language: "ts",
  contentHash: "snippet-hash",
  source: null,
  graph: { repoConnectionId: "a" },
  ...overrides,
});
const chunk = (overrides = {}) => ({
  id: "c",
  documentId: "d",
  document: { filename: "shared.txt" },
  text: "primary",
  position: 0,
  metadata: '{"a":1,"b":2}',
  embeddingModel: "embed",
  chunkerIdentity: "text:v1",
  ...overrides,
});
const finding = (overrides = {}) => ({
  id: "f",
  symbolId: "s",
  category: "rationale",
  title: "Why",
  body: "Because",
  evidence: '{"line":1}',
  severity: "info",
  derivation: "extracted",
  confidence: 1,
  verificationStatus: "confirmed",
  ...overrides,
});
const bundle = () => ({
  provider: { model: "model", offline: false },
  tuning: { phase1Model: "facts", phase2Model: "sections" },
  supportsCaching: true,
  factsCharCap: 48000,
});
let root: string;
const capture = () => captureGenerationInputs(doc, policy);
const keys = (snapshot: Awaited<ReturnType<typeof capture>>, kind: string) =>
  Object.keys(snapshot.items).filter((key) => key.startsWith(`${kind}:`));
async function file(name: string, text: string) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), text);
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(path.join(tmpdir(), "generation-inputs-"));
  mocks.symbols.mockResolvedValue([]);
  mocks.edges.mockResolvedValue([]);
  mocks.chunks.mockResolvedValue([]);
  mocks.findings.mockResolvedValue([]);
  mocks.project.mockResolvedValue({ name: "Project", description: "Description" });
  mocks.repositories.mockResolvedValue(
    new Map([["g", { codeGraphId: "g", repoConnectorId: "a", root, commitSha: "head" }]]),
  );
  mocks.filter.mockImplementation(async (candidates: unknown[]) => candidates);
  mocks.config.mockReturnValue({
    provider: "local-gemma",
    model: "model",
    offline: false,
    sdkProvider: { type: "openai", baseUrl: "http://localhost/v1", apiKey: "DO-NOT-PERSIST" },
    modelProfileMap: { x: "profile-x", y: "profile-y" },
  });
  mocks.phase1.mockReturnValue(bundle());
  mocks.router.mockReturnValue({ primary: bundle(), hybrid: null });
  mocks.web.mockResolvedValue(null);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("captureGenerationInputs", () => {
  it("returns immutable hashes only, without mutating or retaining inputs", async () => {
    const source = symbol();
    mocks.symbols.mockResolvedValue([source]);
    await file("src/mod.ts", "secret source bytes");
    const snapshot = await capture();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
    expect(Object.values(snapshot.items).every((value) => /^[a-f0-9]{64}$/.test(value))).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(
      /DO-NOT-PERSIST|secret source bytes|localhost|M\.run/,
    );
    const saved = JSON.stringify(snapshot);
    source.contentHash = "changed";
    expect(JSON.stringify(snapshot)).toBe(saved);
    expect((await capture()).fingerprint).not.toBe(snapshot.fingerprint);
  });

  it("canonicalizes nested config, policy, filter and metadata object key order", async () => {
    mocks.chunks.mockResolvedValue([chunk()]);
    const baseline = await capture();
    const config = mocks.config();
    mocks.config.mockReturnValue({
      modelProfileMap: { y: "profile-y", x: "profile-x" },
      sdkProvider: { apiKey: "DO-NOT-PERSIST", baseUrl: "http://localhost/v1", type: "openai" },
      offline: config.offline,
      model: config.model,
      provider: config.provider,
    });
    mocks.chunks.mockResolvedValue([chunk({ metadata: '{"b":2,"a":1}' })]);
    expect(
      (
        await captureGenerationInputs(
          { ...doc, evidencePolicy: '{ "allowWebResearch": false, "version": 1 }' },
          policy,
        )
      ).fingerprint,
    ).toBe(baseline.fingerprint);
  });

  it("distinguishes overloaded and identical declarations without row-id churn", async () => {
    mocks.symbols.mockResolvedValue([
      symbol(),
      symbol({ id: "s2", startLine: 4, endLine: 5 }),
      symbol({ id: "s3" }),
    ]);
    const baseline = await capture();
    expect(keys(baseline, "symbol")).toHaveLength(3);
    mocks.symbols.mockResolvedValue([
      symbol({ id: "new3" }),
      symbol({ id: "new2", startLine: 4, endLine: 5 }),
      symbol({ id: "new1" }),
    ]);
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
    mocks.symbols.mockResolvedValue([symbol(), symbol({ startLine: 4, endLine: 5 })]);
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
  });

  it("tracks edge multiplicity, endpoint identity, unresolved targets and metadata", async () => {
    const edge = {
      fromSymbol: symbol(),
      toSymbol: symbol({ startLine: 8 }),
      kind: "calls",
      toQualifiedName: "target",
      filePath: "src/mod.ts",
      line: 1,
      metadata: '{"lineage":{"reads":["table"]}}',
      source: null,
    };
    mocks.edges.mockResolvedValue([edge, { ...edge, metadata: null }]);
    const baseline = await capture();
    expect(keys(baseline, "edge")).toHaveLength(2);
    mocks.edges.mockResolvedValue([{ ...edge, metadata: null }, edge]);
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
    for (const change of [
      { toSymbol: null },
      { toQualifiedName: "other" },
      { metadata: "invalid" },
      { toSymbol: symbol({ startLine: 9 }) },
    ]) {
      mocks.edges.mockResolvedValue([
        { ...edge, ...change },
        { ...edge, metadata: null },
      ]);
      expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    }
    mocks.edges.mockResolvedValue([edge]);
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
  });

  it("captures full source edits outside unchanged symbol snippets and file deletion", async () => {
    mocks.symbols.mockResolvedValue([symbol(), symbol({ id: "s2" })]);
    await file("src/mod.ts", "function run() {}\n// unindexed constant = 1");
    const baseline = await capture();
    expect(keys(baseline, "source")).toHaveLength(1);
    expect(mocks.read.mock.calls.filter(([name]) => name.endsWith("/src/mod.ts"))).toHaveLength(1);
    await file("src/mod.ts", "function run() {}\n// unindexed constant = 2");
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    await rm(path.join(root, "src/mod.ts"));
    const missing = await capture();
    expect(missing.fingerprint).not.toBe(baseline.fingerprint);
    await file("src/mod.ts", "function run() {}\n// unindexed constant = 1");
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
  });

  it("tracks finding additions, deletions and consumed body/provenance metadata", async () => {
    mocks.symbols.mockResolvedValue([symbol()]);
    const empty = await capture();
    mocks.findings.mockResolvedValue([finding(), finding({ id: "f2" })]);
    const baseline = await capture();
    expect(keys(baseline, "finding")).toHaveLength(2);
    expect(baseline.fingerprint).not.toBe(empty.fingerprint);
    for (const change of [
      { body: "different reason" },
      { evidence: '{"line":2}' },
      { confidence: 0.5 },
      { derivation: "inferred" },
      { verificationStatus: null },
      { category: "rationale-todo" },
    ]) {
      mocks.findings.mockResolvedValue([finding(change), finding()]);
      expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    }
    mocks.findings.mockResolvedValue([]);
    expect((await capture()).fingerprint).toBe(empty.fingerprint);
  });

  it("bounds rationale SQL binds and never queries unlinked/project-wide findings", async () => {
    mocks.repositories.mockResolvedValue(new Map());
    mocks.symbols.mockResolvedValue(
      Array.from({ length: 501 }, (_, i) => symbol({ id: `s${i}`, startLine: i })),
    );
    await capture();
    expect(mocks.findings.mock.calls.map(([query]) => query.where.symbolId.in.length)).toEqual([
      500, 1,
    ]);
    expect(mocks.findings.mock.calls[0][0].where).toMatchObject({
      agentResult: { analysis: { projectId: "p" } },
      category: { in: ["rationale", "rationale-todo"] },
    });
  });

  it("preserves same-filename documents and same-position chunk duplicates", async () => {
    mocks.chunks.mockResolvedValue([
      chunk(),
      chunk({ id: "c2", documentId: "d2" }),
      chunk({ id: "c3", text: "second" }),
    ]);
    const baseline = await capture();
    expect(keys(baseline, "evidence")).toHaveLength(3);
    mocks.chunks.mockResolvedValue([
      chunk({ id: "new3", text: "second" }),
      chunk({ id: "new2", documentId: "d2" }),
      chunk({ id: "new1" }),
    ]);
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
    mocks.chunks.mockResolvedValue([chunk(), chunk({ documentId: "d2" })]);
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
  });

  it("uses only the eligible primary evidence pool and tracks embedding/metadata changes", async () => {
    mocks.chunks.mockResolvedValue([chunk()]);
    const baseline = await capture();
    for (const change of [
      { metadata: '{"source":"new"}' },
      { embeddingModel: "embed-v2" },
      { chunkerIdentity: "text:v2" },
    ]) {
      mocks.chunks.mockResolvedValue([chunk(change)]);
      expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    }
    mocks.filter.mockResolvedValue([]);
    const excluded = await capture();
    expect(keys(excluded, "evidence")).toEqual([]);
    mocks.chunks.mockResolvedValue([chunk({ text: "generated or denied" })]);
    expect((await capture()).fingerprint).toBe(excluded.fingerprint);
    expect(mocks.filter).toHaveBeenCalledWith(expect.any(Array), policy);
  });

  it("constrains all reads to the resolved repository and shared reference allowlist", async () => {
    await captureGenerationInputs(doc, { ...policy, sharedDocumentIds: ["shared"] });
    expect(mocks.symbols).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: "p", codeGraphId: "g" } }),
    );
    expect(mocks.edges).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: "p",
          codeGraphId: "g",
          kind: { in: ["calls", "imports", "references"] },
        },
      }),
    );
    expect(mocks.repositories).toHaveBeenCalledWith({ projectId: "p", codeGraphId: "g" });
    expect(mocks.chunks.mock.calls[0][0].where.document).toEqual({
      deletedAt: null,
      indexState: "indexed",
      OR: [{ filename: { startsWith: "connector:repo:a:" } }, { id: { in: ["shared"] } }],
    });
  });

  it("fails closed on missing repository policy or mismatched project", async () => {
    for (const invalid of [
      { ...policy, codeGraphId: undefined },
      { ...policy, repoConnectorId: undefined },
      { ...policy, projectId: "other" },
    ]) {
      await expect(captureGenerationInputs(doc, invalid)).rejects.toThrow();
    }
    expect(mocks.symbols).not.toHaveBeenCalled();
  });

  it("supports full-project scope, graph-only repositories and unavailable sources", async () => {
    mocks.repositories.mockResolvedValue(
      new Map([["g", { codeGraphId: "g", repoConnectorId: null, root: null }]]),
    );
    const full = { ...doc, scope: "full" };
    const unscoped = { ...policy, repoConnectorId: undefined, codeGraphId: undefined };
    const baseline = await captureGenerationInputs(full, unscoped);
    expect(keys(baseline, "repository")).toHaveLength(1);
    expect(mocks.symbols.mock.calls[0][0].where).toEqual({ projectId: "p" });
    expect(mocks.chunks.mock.calls[0][0].where.document).not.toHaveProperty("OR");
    mocks.repositories.mockResolvedValue(
      new Map([["g", { codeGraphId: "g", repoConnectorId: null, root }]]),
    );
    expect((await captureGenerationInputs(full, unscoped)).fingerprint).not.toBe(
      baseline.fingerprint,
    );
  });

  it("does not invalidate from arbitrary non-source files or other repository contents", async () => {
    const baseline = await capture();
    await file("unindexed/readme.md", "irrelevant");
    await file("node_modules/pkg/schema.sql", "ignored");
    await file(".hidden/schema.sql", "ignored");
    await file("tests/schema.sql", "ignored");
    await file("vendor/schema.sql", "ignored");
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("tracks SQL-only directory additions, edits and deletions", async () => {
    const empty = await capture();
    await file("sql/schema.SQL", "CREATE TABLE a(id INT);");
    const added = await capture();
    expect(keys(added, "sql")).toHaveLength(1);
    expect(added.fingerprint).not.toBe(empty.fingerprint);
    await file("sql/schema.SQL", "CREATE TABLE b(id INT);");
    expect((await capture()).fingerprint).not.toBe(added.fingerprint);
    await rm(path.join(root, "sql/schema.SQL"));
    expect((await capture()).fingerprint).toBe(empty.fingerprint);
  });

  it("fingerprints every SQL file in full, as Phase 1 mines them (no file or character cap)", async () => {
    for (let i = 0; i < 14; i++) await file(`sql/${String(i).padStart(2, "0")}.sql`, "SELECT 1;");
    expect(keys(await capture(), "sql")).toHaveLength(14);
    await file("sql/00.sql", "x".repeat(80_001));
    expect(keys(await capture(), "sql")).toHaveLength(14);
  });

  it("discovers past the old 2000-directory budget, within the shared safety bound", async () => {
    await file("z-source/mod.ts", "full source");
    await file("z-source/schema.sql", "SELECT 1;");
    mocks.symbols.mockResolvedValue([symbol({ filePath: "z-source/mod.ts" })]);
    // Fake a huge root listing, keeping real containment checks for every path.
    mocks.list.mockResolvedValueOnce(
      Array.from({ length: 2100 }, (_, i) => ({
        name: `empty-${i}`,
        isFile: () => false,
        isDirectory: () => true,
      })),
    );
    const snapshot = await capture();
    expect(keys(snapshot, "sql")).toHaveLength(1);
    expect(
      mocks.resolve.mock.calls.filter(([, relative]) => relative.startsWith("empty-")),
    ).toHaveLength(2100);
    expect(mocks.resolve).toHaveBeenCalledWith(root, "z-source");
  });

  it("scans a directory with 200,000 subdirectories without an argument-spread overflow (#191)", async () => {
    // `queue.push(...children)` passed every child as a call argument and threw
    // a RangeError past ~130k on Node 22, failing the whole capture.
    mocks.list.mockResolvedValueOnce(
      Array.from({ length: 200_000 }, (_, i) => ({
        name: `d${i}`,
        isFile: () => false,
        isDirectory: () => true,
      })),
    );
    const fs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const sources =
      await vi.importActual<typeof import("./repository-sources.js")>("./repository-sources.js");
    mocks.list.mockImplementation(async () => []);
    mocks.resolve.mockImplementation(async (base: string, relative: string) =>
      path.join(base, relative),
    );
    try {
      await expect(capture()).resolves.toBeDefined();
      // The safety bound still applies: SQL_SCAN_DIR_CAP directories are listed.
      expect(mocks.list.mock.calls.length).toBe(100_000);
    } finally {
      mocks.list.mockReset().mockImplementation(fs.readdir as never);
      mocks.resolve.mockReset().mockImplementation(sources.resolveSourcePath);
    }
  });

  it("keeps same-path inputs in different repositories distinct", async () => {
    mocks.symbols.mockResolvedValue([
      symbol(),
      symbol({ id: "other", codeGraphId: "g2", graph: { repoConnectionId: "b" } }),
    ]);
    const snapshot = await captureGenerationInputs(
      { ...doc, scope: "full" },
      { ...policy, repoConnectorId: undefined, codeGraphId: undefined },
    );
    expect(keys(snapshot, "symbol")).toHaveLength(2);
  });

  it("still inventories SQL in symbol-derived directories skipped by discovery", async () => {
    mocks.symbols.mockResolvedValue([symbol({ filePath: "tests/mod.ts" })]);
    await file("tests/mod.ts", "source");
    await file("tests/schema.sql", "SELECT 1");
    const snapshot = await capture();
    expect(keys(snapshot, "source")).toHaveLength(1);
    expect(keys(snapshot, "sql")).toHaveLength(1);
  });

  it("does not read traversal, absolute paths, or symlink escapes", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "generation-outside-"));
    try {
      await writeFile(path.join(outside, "secret.ts"), "must not read");
      await symlink(outside, path.join(root, "escape"));
      mocks.symbols.mockResolvedValue([
        symbol({ filePath: `${outside}/secret.ts` }),
        symbol({ id: "s2", filePath: "../secret.ts" }),
        symbol({ id: "s3", filePath: "escape/secret.ts" }),
        symbol({ id: "s4", filePath: "C:\\secret.ts" }),
      ]);
      const snapshot = await capture();
      expect(keys(snapshot, "source")).toHaveLength(4);
      expect(mocks.read).not.toHaveBeenCalled();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("ignores junk graph symbols before source/finding inventory", async () => {
    const baseline = await capture();
    mocks.symbols.mockResolvedValue([symbol({ filePath: "__MACOSX/._mod.ts" })]);
    expect((await capture()).fingerprint).toBe(baseline.fingerprint);
    expect(mocks.findings).not.toHaveBeenCalled();
  });

  it.each(["provider", "model", "offline", "sdkProvider", "modelProfileMap"])(
    "fingerprints effective provider %s, not merely docs-gen tuning",
    async (field) => {
      const baseline = await capture();
      mocks.config.mockReturnValue({
        ...mocks.config(),
        [field]: field === "offline" ? true : "changed",
      });
      expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    },
  );

  it("fingerprints actual fallback model, hybrid bundles, env tuning and endpoints", async () => {
    const baseline = await capture();
    mocks.phase1.mockReturnValue({ ...bundle(), provider: { model: "fallback", offline: true } });
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    mocks.phase1.mockReturnValue(bundle());
    mocks.router.mockReturnValue({
      primary: bundle(),
      hybrid: { local: bundle(), escalation: { ...bundle(), factsCharCap: 90000 } },
    });
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    mocks.router.mockReturnValue({ primary: bundle(), hybrid: null });
    for (const name of [
      "DOCS_GEN_TEST",
      "DOCS_GROUNDING_TEST",
      "DOCS_FAITHFULNESS_TEST",
      "BEDROCK_GATEWAY_BASE_URL",
      "LOCAL_GEMMA_BASE_URL",
      "ANTHROPIC_BASE_URL",
    ]) {
      vi.stubEnv(name, "changed");
      expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
      vi.unstubAllEnvs();
    }
  });

  it("includes web digests only when enabled and handles absent research", async () => {
    await capture();
    expect(mocks.web).not.toHaveBeenCalled();
    const webPolicy = { ...policy, allowWebResearch: true };
    const empty = await captureGenerationInputs(doc, webPolicy);
    mocks.web.mockResolvedValue({
      digests: [{ url: "https://example.test", text: "primary web evidence" }],
    });
    expect((await captureGenerationInputs(doc, webPolicy)).fingerprint).not.toBe(empty.fingerprint);
  });

  it("keeps malformed JSON as a distinct value and preserves meaningful array order", async () => {
    mocks.chunks.mockResolvedValue([chunk({ metadata: "invalid" })]);
    const baseline = await capture();
    mocks.chunks.mockResolvedValue([chunk({ metadata: "different-invalid" })]);
    expect((await capture()).fingerprint).not.toBe(baseline.fingerprint);
    mocks.config.mockReturnValue({ ordered: [1, 2] });
    const ordered = await capture();
    mocks.config.mockReturnValue({ ordered: [2, 1] });
    expect((await capture()).fingerprint).not.toBe(ordered.fingerprint);
  });
});
