/**
 * #67 — a degraded document's `section-failed` warning must never carry raw
 * exception text.
 *
 * `synthesizeFinalDocument` used to build the warning from `String(err)`, and
 * `sectionFailedWarning` appended up to 300 characters of it to a message that
 * is persisted in the `warnings` column, returned by
 * `GET /projects/:projectId/docs/:docId` and rendered in the UI banner — the
 * same exposure #52 closed for a *failed* document's `errorMessage`, on the
 * *degraded* path. Provider response bodies, absolute paths and SQL text
 * reached the browser.
 *
 * This drives the real synthesis loop (the path production runs) with a
 * provider whose stream throws, and asserts on the warning that comes back.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import type { AIConfig } from "../ai/config.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";
import {
  GENERATION_FAILED_MESSAGE,
  GENERATION_PROVIDER_BALANCE_MESSAGE,
} from "./generation-failure-message.js";

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

/** The exception the section generator throws; `null` means "succeed". */
const state: { sectionError: unknown } = { sectionError: null };

const loadConfig = vi.hoisted(() => vi.fn());
const provider = {
  key: "bedrock-gateway",
  model: "fixture",
  offline: false,
  chat: vi.fn(async (messages: Array<{ content: unknown }>) => {
    const judge = messages.some((m) => String(m.content).includes("strict faithfulness judge"));
    return {
      content: JSON.stringify(
        judge
          ? { verdicts: [{ claim: "Source facts.", supported: true, sourceIds: [] }] }
          : { claims: [{ claim: "Source facts.", sourceIds: [] }] },
      ),
    };
  }),
  async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
    const prompt = String(messages.at(-1)?.content);
    if (prompt.includes("section group now")) {
      if (state.sectionError !== null) throw state.sectionError;
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)![1];
      yield { type: "delta", content: `## ${label}\n\nSource facts.` };
    } else {
      yield { type: "delta", content: "PURPOSE\n- Source facts.\n\nRULES\n- Validate orders." };
    }
    yield { type: "done", finishReason: "stop" };
  },
} as unknown as AIProvider;
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
function synth() {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router(),
    "p",
    undefined,
    undefined,
    async () => context("Source facts."),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.sectionError = null;
  loadConfig.mockReturnValue({
    provider: "bedrock-gateway",
    model: "fixture",
    sdkProvider: {
      type: "openai",
      baseUrl: "https://fixture.invalid/v1",
      apiKey: "fixture-secret",
    },
  });
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("BEDROCK_GATEWAY_URL", "");
  vi.stubEnv("BEDROCK_GATEWAY_BASE_URL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("synthesizeFinalDocument — section-failed warnings carry no raw exception text (#67)", () => {
  it("does not echo the exception's message, path or payload into the warning", async () => {
    state.sectionError = new Error(
      'deepseek returned 500: {"error":"relation \\"projects\\" does not exist"} ' +
        "at /srv/metis/server/src/lib/docs-gen/holistic-synthesizer.ts:2881:15",
    );
    const result = await synth();
    const failed = result.warnings.filter((w) => w.kind === "section-failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const w of failed) {
      expect(w.message).not.toContain("deepseek");
      expect(w.message).not.toContain("relation");
      expect(w.message).not.toContain("/srv/metis");
      expect(w.message).not.toContain("holistic-synthesizer.ts");
      // The fixed vocabulary, not a truncated exception.
      expect(w.message).toContain(GENERATION_FAILED_MESSAGE);
      expect(w.message).toContain(`Section "${w.section}" could not be generated`);
    }
    // Still a real, surfaceable degradation — not swallowed.
    expect(result.warnings.some((w) => w.severity === "error")).toBe(true);
  });

  it("keeps a provider balance failure recognisable as a balance problem", async () => {
    state.sectionError = Object.assign(
      new Error('deepseek returned 402: {"error":{"message":"Insufficient Balance"}}'),
      { status: 402 },
    );
    const result = await synth();
    const failed = result.warnings.filter((w) => w.kind === "section-failed");
    expect(failed.length).toBeGreaterThan(0);
    for (const w of failed) {
      expect(w.message).toContain(GENERATION_PROVIDER_BALANCE_MESSAGE);
      expect(w.message).not.toContain("deepseek");
    }
  });

  it("marks the warnings it builds as carrying METIS-authored detail", async () => {
    state.sectionError = new Error("secret detail");
    const result = await synth();
    for (const w of result.warnings.filter((x) => x.kind === "section-failed")) {
      expect(w.detailSafe).toBe(true);
    }
  });

  it("leaves a clean run with no section-failed warnings at all", async () => {
    const result = await synth();
    expect(result.warnings.filter((w) => w.kind === "section-failed")).toEqual([]);
    expect(groups.length).toBeGreaterThan(0);
  });
});
