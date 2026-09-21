import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import type { AIConfig } from "../ai/config.js";
import { OpenAICompatibleProvider } from "../ai/providers/openai-compatible-provider.js";
import { BedrockDirectProvider } from "../ai/providers/bedrock-direct-provider.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  synthesizeHolisticDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import {
  legacyGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";

const db = vi.hoisted(() => ({
  project: { findUnique: vi.fn() },
  codeGraph: { findMany: vi.fn() },
  codeSymbol: { findMany: vi.fn(), groupBy: vi.fn() },
  codeEdge: { findMany: vi.fn() },
  finding: { findMany: vi.fn() },
  docsGenFactCache: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
vi.mock("../finops/index.js", () => ({ recordUsage: vi.fn() }));

const loadConfig = vi.hoisted(() => vi.fn());
const calls = {
  sections: [] as string[],
  phase1: 0,
  grounding: 0,
  truncated: false,
  empty: false,
  phase1Requests: [] as { prompt: string; maxTokens?: number }[],
};
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async (messages) => {
    calls.grounding++;
    const judge = messages.some((m) => String(m.content).includes("strict faithfulness judge"));
    return {
      content: JSON.stringify(
        judge
          ? { verdicts: [{ claim: "Source facts.", supported: true, sourceIds: [] }] }
          : { claims: [{ claim: "Source facts.", sourceIds: [] }] },
      ),
    };
  }),
  async *stream(messages, options): AsyncGenerator<ChatChunk> {
    const prompt = String(messages.at(-1)?.content);
    if (prompt.includes("section group now")) {
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)![1];
      calls.sections.push(label);
      yield { type: "delta", content: calls.empty ? "" : `## ${label}\n\nSource facts.` };
    } else {
      calls.phase1++;
      calls.phase1Requests.push({ prompt, maxTokens: options?.maxTokens });
      yield { type: "delta", content: "PURPOSE\n- Source facts.\n\nRULES\n- Validate orders." };
    }
    yield { type: "done", finishReason: calls.truncated ? "length" : "stop" };
  },
} as AIProvider;
vi.mock("../ai/index.js", () => ({
  loadAIConfig: loadConfig,
  buildProvider: ({ config }: { config: AIConfig }) => ({
    ...provider,
    key: config.provider,
    model: config.model,
  }),
}));

const meta = { name: "Project", language: "typescript", totalFiles: 1, totalSymbols: 3 };
const facts: ModuleFacts[] = [
  {
    modulePath: "src/orders",
    moduleName: "orders",
    classCount: 1,
    methodCount: 2,
    facts: "Validate orders.",
    formulas: [],
    topClasses: ["Order"],
  },
];
const groups = sectionGroupsFor("architecture");
const context = (text: string): GroundingContext => ({
  sources: [
    {
      sourceId: "rag:reference:1",
      kind: "rag",
      label: "Reference",
      text,
      documentId: "reference",
      chunkId: "1",
      evidenceClass: "project-reference",
    },
  ],
  sourceIds: new Set(["rag:reference:1"]),
  isEmpty: false,
});
function router(): Phase2Router {
  const tuning = docsGenTuning("bedrock", "fixture");
  return {
    primary: {
      kind: "bedrock",
      provider,
      tuning,
      factsCharCap: tuning.factsCharCap,
      supportsCaching: false,
    },
    hybrid: null,
  };
}
type Result = Awaited<ReturnType<typeof synthesizeFinalDocument>>;
function previous(result: Result) {
  return {
    ...legacyGeneratedDocVersionManifest({ projectId: "p", generatedDocumentId: "d", version: 1 }),
    sectionSynthesis: result.sectionSynthesis,
  };
}
function synth(
  prior?: Result,
  groundingForSection = async () => context("Source facts."),
  route = router(),
) {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    route,
    "p",
    undefined,
    undefined,
    groundingForSection,
    undefined,
    {
      previousManifest: prior ? previous(prior) : undefined,
      effectiveConfigHash: "resolved-fixture-config",
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  loadConfig.mockReturnValue({
    provider: "bedrock-gateway",
    model: "fixture",
    sdkProvider: {
      type: "openai",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-secret",
    },
  });
  calls.sections = [];
  calls.phase1 = calls.grounding = 0;
  calls.truncated = calls.empty = false;
  calls.phase1Requests = [];
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("actual section synthesis reuse", () => {
  it("skips both section generation and grounding calls for byte-equivalent dependencies", async () => {
    const cold = await synth();
    expect(cold.regeneration?.mode).toBe("full");
    expect(cold.sectionSynthesis?.records).toHaveLength(groups.length);
    expect(calls.grounding).toBeGreaterThan(0);
    calls.sections = [];
    calls.grounding = 0;
    const warm = await synth(cold);
    expect(calls.sections).toEqual([]);
    expect(calls.grounding).toBe(0);
    expect(warm.regeneration).toEqual({ mode: "unchanged", changed: [] });
    expect(warm.markdown).toBe(cold.markdown);
    expect(warm.sections).toEqual(cold.sections);
    expect(warm.selectedEvidence).toEqual(cold.selectedEvidence);
    expect(warm.sectionSynthesis).toEqual(cold.sectionSynthesis);
  });

  it("regenerates only a changed section via the existing grounding pipeline, retaining other warnings", async () => {
    calls.truncated = true;
    const cold = await synth();
    expect(cold.warnings.filter((w) => w.kind === "section-truncated")).toHaveLength(groups.length);
    calls.truncated = false;
    calls.sections = [];
    calls.grounding = 0;
    const changed = await synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
      undefined,
      undefined,
      async ({ id }) => context(id === groups[1].id ? "New source facts." : "Source facts."),
      undefined,
      { previousManifest: previous(cold), effectiveConfigHash: "resolved-fixture-config" },
    );
    expect(calls.sections).toEqual([groups[1].label]);
    expect(calls.grounding).toBeGreaterThan(0);
    expect(changed.regeneration).toEqual({
      mode: "sections",
      changed: [groups[1].id],
      sections: [groups[1].id],
    });
    expect(changed.warnings.filter((w) => w.kind === "section-truncated")).toHaveLength(
      groups.length - 1,
    );
    expect(changed.warnings.some((w) => w.section === groups[1].label)).toBe(false);
    expect(changed.sectionSynthesis?.records[0]).toEqual(cold.sectionSynthesis?.records[0]);
    expect(changed.sectionSynthesis?.records[1].warnings).toEqual([]);
  });

  it.each([
    "facts",
    "add",
    "delete",
    "formulas",
    "flow",
    "title",
    "meta",
    "provider",
    "claim",
    "judge",
    "budget",
    "config",
  ])("invalidates all sections when shared %s inputs change", async (kind) => {
    const cold = await synth();
    const nextFacts = structuredClone(facts);
    const nextRouter = router();
    if (kind === "facts") nextFacts[0].facts += " New rule.";
    if (kind === "add")
      nextFacts.push({ ...facts[0], modulePath: "new/module", moduleName: "new" });
    if (kind === "delete") nextFacts.length = 0;
    if (kind === "formulas")
      nextFacts[0].formulas.push({ kind: "arithmetic", expression: "x + 1", line: 1 } as never);
    if (kind === "provider") nextRouter.primary.provider = { ...provider, model: "other" };
    if (kind === "claim") nextRouter.primary.tuning.claimModel = "other";
    if (kind === "judge") nextRouter.primary.tuning.judgeModel = "other";
    if (kind === "budget") vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "1500");
    calls.sections = [];
    const result = await synthesizeFinalDocument(
      nextFacts,
      kind === "meta" ? { ...meta, totalFiles: 2 } : meta,
      "architecture",
      kind === "title" ? "New title" : "Architecture",
      nextRouter,
      "p",
      undefined,
      undefined,
      async () => context("Source facts."),
      kind === "flow"
        ? {
            perModuleLineage: new Map(),
            datasetLineage: [],
            crossModuleDeps: new Map([["a", new Set(["b"])]]),
          }
        : undefined,
      {
        previousManifest: previous(cold),
        effectiveConfigHash: kind === "config" ? "changed" : "resolved-fixture-config",
      },
    );
    expect(calls.sections).toHaveLength(groups.length);
    expect(result.regeneration?.mode).toBe("full");
  });

  it("falls back to full for incomplete/altered records and shared hybrid escalation", async () => {
    const cold = await synth();
    for (const invalid of [
      undefined,
      { ...cold.sectionSynthesis!, records: cold.sectionSynthesis!.records.slice(1) },
    ]) {
      calls.sections = [];
      const result = await synth({ ...cold, sectionSynthesis: invalid });
      expect(calls.sections).toHaveLength(groups.length);
      expect(result.regeneration?.mode).toBe("full");
    }
    calls.sections = [];
    vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "1");
    const hybrid = router();
    hybrid.hybrid = { local: hybrid.primary, escalation: hybrid.primary };
    const result = await synth(cold, undefined, hybrid);
    expect(calls.sections).toHaveLength(groups.length);
    expect(result.sectionSynthesis).toBeUndefined();
    expect(result.regeneration?.mode).toBe("full");
  });

  it("never records completeness after empty output", async () => {
    calls.empty = true;
    const result = await synth();
    expect(result.sectionSynthesis).toBeUndefined();
    expect(result.regeneration?.mode).toBe("full");
    expect(result.warnings.some((w) => w.kind === "section-failed")).toBe(true);
  });

  it("requires resolved provider configuration before certifying completeness", async () => {
    const result = await synthesizeFinalDocument(
      facts,
      meta,
      "architecture",
      "Architecture",
      router(),
      "p",
    );
    expect(result.sectionSynthesis).toBeUndefined();
    expect(result.regeneration?.mode).toBe("full");
  });
});

async function withPhase1Fixture(
  run: (fixture: {
    root: string;
    symbols: {
      id: string;
      codeGraphId: string;
      qualifiedName: string;
      kind: string;
      filePath: string;
      language: string;
      startLine: number;
      endLine: number;
      contentHash: string;
    }[];
    cache: Map<string, unknown>;
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "metis-section-reuse-"));
  try {
    await mkdir(path.join(root, "a", ".git"), { recursive: true });
    await mkdir(path.join(root, "a", "src"), { recursive: true });
    await writeFile(path.join(root, "a", ".git", "HEAD"), "ref: refs/heads/main");
    await writeFile(
      path.join(root, "a", "src", "rules.ts"),
      "export class Rules { check() { return true; } }",
    );
    vi.stubEnv("REPO_CLONE_DIR", root);
    db.project.findUnique.mockResolvedValue({ name: "Project" });
    db.codeGraph.findMany.mockResolvedValue([
      { id: "g", repoConnection: { id: "a", projectId: "p", deletedAt: null } },
    ]);
    const symbols = ["class", "method", "method"].map((kind, i) => ({
      id: `s${i}`,
      codeGraphId: "g",
      qualifiedName: `Rules${i}`,
      kind,
      filePath: "src/rules.ts",
      language: "ts",
      startLine: 1,
      endLine: 1,
      contentHash: `hash${i}`,
    }));
    db.codeSymbol.findMany.mockResolvedValue(symbols);
    db.codeSymbol.groupBy.mockResolvedValue([
      { codeGraphId: "g", filePath: "src/rules.ts", _count: { _all: 3 } },
    ]);
    db.codeEdge.findMany.mockResolvedValue([]);
    db.finding.findMany.mockResolvedValue([]);
    db.docsGenFactCache.update.mockResolvedValue({});
    const cache = new Map<string, unknown>();
    db.docsGenFactCache.findUnique.mockImplementation(
      async ({ where }) => cache.get(where.projectId_cacheKey.cacheKey) ?? null,
    );
    db.docsGenFactCache.upsert.mockImplementation(async ({ create }) => {
      cache.set(create.cacheKey, { ...create, id: create.cacheKey, createdAt: new Date() });
      return create;
    });
    await run({ root, symbols, cache });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

it("production entry point persists records and reuses them without rebuilding phase-one cached facts", async () => {
  await withPhase1Fixture(async () => {
    const cold = await synthesizeHolisticDocument("p", "architecture", "Architecture", {
      grounding: context("Source facts."),
    });
    const manifest = parseGeneratedDocVersionManifest(cold.provenanceManifest);
    expect(manifest.sectionSynthesis?.records).toHaveLength(groups.length);
    expect(calls.phase1).toBe(1);
    calls.sections = [];
    calls.phase1 = calls.grounding = 0;
    const warm = await synthesizeHolisticDocument("p", "architecture", "Architecture", {
      grounding: context("Source facts."),
      previousManifest: manifest,
    });
    expect(calls.phase1).toBe(0);
    expect(db.docsGenFactCache.update).toHaveBeenCalled();
    expect(calls.sections).toEqual([]);
    expect(calls.grounding).toBe(0);
    const saved = parseGeneratedDocVersionManifest(warm.provenanceManifest);
    expect(saved.regeneration?.mode).toBe("unchanged");
    expect(saved.sections).toEqual(manifest.sections);
    expect(saved.selectedEvidence).toEqual(manifest.selectedEvidence);
    calls.sections = [];
    const partial = await synthesizeHolisticDocument("p", "architecture", "Architecture", {
      grounding: context("Source facts."),
      previousManifest: saved,
      groundingForSection: async ({ id }) =>
        context(id === groups[1].id ? "Updated evidence." : "Source facts."),
    });
    expect(calls.sections).toEqual([groups[1].label]);
    expect(parseGeneratedDocVersionManifest(partial.provenanceManifest).regeneration).toEqual({
      mode: "sections",
      changed: [groups[1].id],
      sections: [groups[1].id],
    });
  });
});

describe("production Phase 1 effective-input cache", () => {
  it.each(["DOCS_GEN_LOCAL_TEMPERATURE", "DOCS_GEN_LOCAL_TOP_P", "DOCS_GEN_LOCAL_ENABLE_THINKING"])(
    "invalidates for effective local provider setting %s",
    async (setting) => {
      await withPhase1Fixture(async () => {
        loadConfig().provider = "local-gemma";
        vi.stubEnv("DOCS_GEN_LOCAL_TEMPERATURE", "1");
        vi.stubEnv("DOCS_GEN_LOCAL_TOP_P", "0.95");
        vi.stubEnv("DOCS_GEN_LOCAL_ENABLE_THINKING", "0");
        vi.spyOn(OpenAICompatibleProvider.prototype, "stream").mockImplementation(provider.stream);
        const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
        await run();
        await run();
        expect(calls.phase1).toBe(1);
        vi.stubEnv(setting, setting.endsWith("THINKING") ? "1" : "0.7");
        await run();
        expect(calls.phase1).toBe(2);
        expect(calls.phase1Requests[1].prompt).toBe(calls.phase1Requests[0].prompt);
        await run();
        expect(calls.phase1).toBe(2);
      });
    },
  );

  it("invalidates effective direct Bedrock tuning without depending on credentials", async () => {
    await withPhase1Fixture(async ({ cache }) => {
      vi.stubEnv("BEDROCK_GATEWAY_URL", "https://fixture.invalid/v1");
      vi.stubEnv("BEDROCK_GATEWAY_API_KEY", "direct-secret");
      vi.stubEnv("DOCS_GEN_BEDROCK_TEMPERATURE", "0.2");
      vi.spyOn(BedrockDirectProvider.prototype, "stream").mockImplementation(provider.stream);
      const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
      await run();
      await run();
      expect(calls.phase1).toBe(1);
      vi.stubEnv("DOCS_GEN_BEDROCK_TEMPERATURE", "0.7");
      await run();
      expect(calls.phase1).toBe(2);
      vi.stubEnv("BEDROCK_GATEWAY_API_KEY", "rotated-direct-secret");
      await run();
      expect(calls.phase1).toBe(2);
      expect(JSON.stringify([...cache.values()])).not.toContain("direct-secret");
    });
  });

  it.each([
    "rationale",
    "class-name",
    "method-name",
    "method-range",
    "endpoint",
    "model",
    "provider",
    "output-cap",
  ])(
    "misses for changed %s with unchanged source hashes, then hits the new entry",
    async (change) => {
      await withPhase1Fixture(async ({ symbols, cache }) => {
        const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
        await run();
        expect(calls.phase1).toBe(1);
        const firstRequest = calls.phase1Requests[0];
        await run();
        expect(calls.phase1).toBe(1);
        expect(db.docsGenFactCache.update).toHaveBeenCalledTimes(1);
        if (change === "rationale")
          db.finding.findMany.mockResolvedValue([{ body: "Reject unapproved orders." }]);
        if (change === "class-name") symbols[0].qualifiedName = "RenamedRules";
        if (change === "method-name") symbols[1].qualifiedName = "Rules.checkApproval";
        if (change === "method-range") symbols[1].startLine = symbols[1].endLine = 2;
        const config = loadConfig();
        if (change === "endpoint") config.sdkProvider.baseUrl = "https://changed.invalid/v1";
        if (change === "model") config.model = "other-model";
        if (change === "provider") config.provider = "copilot-native";
        if (change === "output-cap") vi.stubEnv("DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS", "1500");
        await run();
        expect(calls.phase1).toBe(2);
        expect(cache.size).toBe(2);
        if (["rationale", "class-name", "method-name", "method-range"].includes(change)) {
          expect(calls.phase1Requests[1].prompt).not.toBe(firstRequest.prompt);
        } else {
          expect(calls.phase1Requests[1].prompt).toBe(firstRequest.prompt);
        }
        if (change === "rationale")
          expect(calls.phase1Requests[1].prompt).toContain("Reject unapproved orders.");
        if (change === "output-cap") expect(calls.phase1Requests[1].maxTokens).toBe(1500);
        await run();
        expect(calls.phase1).toBe(2);
        expect(db.docsGenFactCache.update).toHaveBeenCalledTimes(2);
        expect(JSON.stringify([...cache.values()])).not.toContain("fixture-secret");
      });
    },
  );

  it("does not invalidate other modules for a module-local rationale change", async () => {
    await withPhase1Fixture(async ({ root, symbols }) => {
      await mkdir(path.join(root, "a", "other"));
      await writeFile(
        path.join(root, "a", "other", "rules.ts"),
        "export class Other { check() { return true; } }",
      );
      symbols.push(
        ...symbols.map((s) => ({ ...s, id: `other-${s.id}`, filePath: "other/rules.ts" })),
      );
      const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
      await run();
      expect(calls.phase1).toBe(2);
      db.finding.findMany.mockImplementation(async ({ where }) =>
        where.symbolId.in.includes("s0") ? [{ body: "Reject unapproved orders." }] : [],
      );
      calls.phase1Requests = [];
      await run();
      expect(calls.phase1).toBe(3);
      expect(calls.phase1Requests).toHaveLength(1);
      expect(calls.phase1Requests[0].prompt).toContain("Module path: `a / src`");
      expect(db.docsGenFactCache.update).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps hits for credential rotation and Phase 2-only tuning changes", async () => {
    await withPhase1Fixture(async ({ cache }) => {
      const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
      await run();
      loadConfig().sdkProvider.apiKey = "rotated-secret";
      vi.stubEnv("DOCS_GEN_BEDROCK_JUDGE_MODEL", "other-judge");
      vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "1500");
      await run();
      expect(calls.phase1).toBe(1);
      expect(db.docsGenFactCache.update).toHaveBeenCalledTimes(1);
      expect(JSON.stringify([...cache.values()])).not.toContain("rotated-secret");
    });
  });

  it("still re-reads and mines source before a potential cache hit", async () => {
    await withPhase1Fixture(async ({ root, cache }) => {
      const run = () => synthesizeHolisticDocument("p", "architecture", "Architecture");
      await run();
      await run();
      expect(calls.phase1).toBe(1);
      await writeFile(
        path.join(root, "a", "src", "rules.ts"),
        'export function check(total: number) { if (total < 10) throw new Error("Minimum order"); return total * 2; }',
      );
      await run();
      expect(calls.phase1).toBe(2);
      expect(calls.phase1Requests[1].prompt).toContain("Minimum order");
      expect(calls.phase1Requests[1].prompt).toContain(
        "DETERMINISTICALLY-MINED TYPESCRIPT RULE INVENTORY",
      );
      await run();
      expect(calls.phase1).toBe(2);
      expect(cache.size).toBe(2);
    });
  });
});
