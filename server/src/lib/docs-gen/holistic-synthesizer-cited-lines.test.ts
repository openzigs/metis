/**
 * #737 — a generated document's footnotes name the source LINE a statement
 * came from, where the module's facts carry one, and the provenance manifest
 * records those lines per cited source. Through `synthesizeFinalDocument` and
 * the manifest; the fake model cites the first facts id it is given. No
 * network, no database, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const scoreFaithfulnessMock = vi.hoisted(() => vi.fn());

vi.mock("./grounding/citation-validator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./grounding/citation-validator.js")>();
  return { ...actual, scoreFaithfulness: scoreFaithfulnessMock };
});

vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: vi.fn() };
});

import type { AIProvider, ChatChunk, ChatMessage } from "../ai/types.js";
import {
  buildGeneratedDocVersionManifest,
  parseGeneratedDocVersionManifest,
} from "./generated-doc-provenance.js";
import {
  docsGenTuning,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";

const RETENTION = "Removed entries are purged after 60 days";

function retentionModule(): ModuleFacts {
  return {
    modulePath: "src/storage",
    moduleName: "storage",
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `storage keeps feeds and entries. ${RETENTION.toLowerCase()} (src/storage/entry.go:310).`,
      "Each request returns at most 1000 entries (src/storage/query.go:42).",
      "RULES",
      `- ${RETENTION} (src/storage/entry.go:310)`,
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

/** Writes one sentence per section restating line 310, citing the first facts id it was given. */
function fakeModel(): AIProvider {
  const provider = {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      const group = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const id = /\bfacts:[^\]\s,;)`]+/.exec(user)?.[0];
      yield {
        type: "delta",
        content: `## ${group}\n\n${RETENTION} [${id ?? "facts:none:0"}].`,
      };
      yield { type: "done", finishReason: "stop" };
    },
    async chat(): Promise<never> {
      throw new Error("chat not used");
    },
    async embed(): Promise<never> {
      throw new Error("embed not used");
    },
    async models(): Promise<string[]> {
      return [];
    },
    async ping(): Promise<boolean> {
      return true;
    },
  };
  return provider as unknown as AIProvider;
}

function routerFor(provider: AIProvider): Phase2Router {
  const tuning = docsGenTuning("anthropic", provider.model);
  const bundle: Phase2ProviderBundle = {
    kind: "anthropic",
    provider,
    supportsCaching: false,
    factsCharCap: tuning.factsCharCap,
    tuning,
  };
  return { primary: bundle, hybrid: null };
}

const META = { name: "Fixture", totalFiles: 4, totalSymbols: 40, language: "go" } as never;

function run(provider: AIProvider) {
  return synthesizeFinalDocument(
    [retentionModule()],
    META,
    "architecture",
    "Architecture",
    routerFor(provider),
    "p1",
    undefined,
    undefined,
    // A per-section retriever that finds nothing: the sections are grounded,
    // so the module facts are admitted as citable sources.
    async () => undefined,
    undefined,
    { effectiveConfigHash: "cfg" },
  );
}

beforeEach(() => {
  scoreFaithfulnessMock.mockReset();
  scoreFaithfulnessMock.mockImplementation(async (section: string) => ({
    section,
    totalClaims: 1,
    supportedClaims: 1,
    faithfulness: 1,
    verified: true,
    unsupportedClaims: [],
    supportedAttributions: [],
  }));
});
afterEach(() => vi.unstubAllEnvs());

describe("cited source lines (#737)", () => {
  it("pins the footnote of a module-facts citation to the line its sentence restates", async () => {
    const result = await run(fakeModel());
    expect(result.markdown).toMatch(
      /^\[\^src-1\]: `src\/storage\/entry\.go:310` — `storage` \(module facts\)$/m,
    );
    expect(result.markdown).not.toMatch(/\[facts:/);
    const cited = [...result.citedLines.values()];
    expect(cited.length).toBeGreaterThan(0);
    for (const lines of cited) {
      expect(lines).toEqual([{ filePath: "src/storage/entry.go", startLine: 310, endLine: 310 }]);
    }
  });

  it("records the cited lines on each selected source in the provenance manifest", async () => {
    const result = await run(fakeModel());
    const tuning = docsGenTuning("anthropic", "m");
    const manifest = parseGeneratedDocVersionManifest(
      buildGeneratedDocVersionManifest({
        revision: { projectId: "p1", generatedDocumentId: "d1", version: 1 },
        title: "Architecture",
        scope: "full",
        docType: "architecture",
        generatedAt: new Date("2026-10-20T00:00:00Z"),
        policy: {
          projectId: "p1",
          generatedDocumentId: "d1",
          actor: { userId: "u", role: "admin" },
          aclSubjects: [],
          sharedDocumentIds: [],
          allowWebResearch: false,
        },
        phase1Tuning: tuning,
        phase2Router: { primary: { tuning } as Phase2ProviderBundle, hybrid: null },
        phase1PromptVersion: 1,
        selectedEvidence: result.selectedEvidence,
        citedLines: result.citedLines,
        graphFingerprint: null,
        sourceRepositories: [],
        sections: [],
      }),
    );
    const withLines = manifest.selectedEvidence.primary.filter((row) => row.citedLines);
    expect(withLines.length).toBe(result.citedLines.size);
    expect(withLines.length).toBeGreaterThan(0);
    for (const row of withLines) {
      expect(row.citedLines).toEqual([
        { filePath: "src/storage/entry.go", startLine: 310, endLine: 310 },
      ]);
    }
    // A source no footnote named a line of carries no field at all.
    for (const row of manifest.selectedEvidence.primary) {
      if (!result.citedLines.has(row.sourceId)) expect(row).not.toHaveProperty("citedLines");
    }
  });
});
