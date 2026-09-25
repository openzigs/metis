/**
 * #175 — facts-cap truncation raises a `facts-truncated` warning on EVERY
 * provider, not only local.
 *
 * `summarizeFactsBudget` ran for every provider but the warning was pushed only
 * inside `if (bundle.kind === "local")`, so a Bedrock or Anthropic document
 * could leave modules out of a section and say nothing on the document.
 *
 * Drives the real synthesis loop with a provider double and a facts cap small
 * enough that most modules cannot fit, then reads the document's warnings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatChunk } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import { deriveDocStatus } from "./grounding/degraded-warnings.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  summarizeFactsBudget,
  synthesizeFinalDocument,
  type ModuleFacts,
  type Phase2Router,
} from "./holistic-synthesizer.js";

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

type Kind = "local" | "bedrock" | "anthropic";

/** A provider double whose every section answers with a short, valid body. */
function makeProvider(key: string): AIProvider {
  return {
    key,
    model: "fixture",
    offline: false,
    chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    async *stream(messages: Array<{ content: unknown }>): AsyncGenerator<ChatChunk> {
      const prompt = String(messages.at(-1)?.content);
      const label = /Section group: \*\*(.+?)\*\*/.exec(prompt)?.[1] ?? "Section";
      yield { type: "delta", content: `## ${label}\n\nSource facts.` };
      yield { type: "done", finishReason: "stop" };
    },
  } as unknown as AIProvider;
}

/** Tight enough that only one ~1.5K-char module fits per section. */
const CAP = 2_000;

const meta = { name: "Project", language: "typescript", totalFiles: 12, totalSymbols: 60 };
const facts: ModuleFacts[] = Array.from({ length: 12 }, (_, i) => ({
  modulePath: `src/module${i}`,
  moduleName: `module${i}`,
  classCount: 1,
  methodCount: 5,
  facts: `Module ${i} validates orders and computes totals. `.repeat(30),
  formulas: [],
  topClasses: [`Class${i}`],
}));

function router(kind: Kind): Phase2Router {
  const provider = makeProvider(`${kind}-fixture`);
  const tuning = docsGenTuning(kind, "fixture");
  return {
    primary: { kind, provider, tuning, factsCharCap: CAP, supportsCaching: false },
    hybrid: null,
  };
}

function synth(kind: Kind) {
  return synthesizeFinalDocument(
    facts,
    meta,
    "architecture",
    "Architecture",
    router(kind),
    "p",
    undefined as GroundingContext | undefined,
  );
}

beforeEach(() => {
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_HYBRID_ROUTING", "0");
  vi.stubEnv("DOCS_GEN_LOCAL_REFINE", "0");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("facts-truncated is raised for every provider kind (#175)", () => {
  it.each<Kind>(["local", "bedrock", "anthropic"])(
    "%s: every over-cap section gets a facts-truncated warning naming it and the omitted count",
    async (kind) => {
      const result = await synth(kind);
      const truncated = result.warnings.filter((w) => w.kind === "facts-truncated");

      // Expected set computed from the same pure budget the synthesizer uses,
      // so the assertion tracks selection rather than restating it.
      const expected = sectionGroupsFor("architecture")
        .map((g) => ({ g, budget: summarizeFactsBudget(facts, g, "architecture", CAP) }))
        .filter(({ budget }) => budget.exceeded);
      expect(expected.length).toBeGreaterThan(0);
      expect(truncated.map((w) => w.section).sort()).toEqual(
        expected.map(({ g }) => g.label).sort(),
      );

      for (const { g, budget } of expected) {
        const w = truncated.find((x) => x.section === g.label)!;
        expect(w.severity).toBe("warning");
        expect(w.message).toContain(`"${g.label}"`);
        expect(w.message).toContain(
          `${budget.omittedModules} of ${budget.omittedModules + budget.includedModules} relevant module(s) were omitted`,
        );
      }
      // The user-visible consequence: the document is marked degraded.
      expect(deriveDocStatus(result.warnings)).toBe("degraded");
    },
  );

  it.each<[Kind, string]>([
    ["local", "DOCS_GEN_LOCAL_FACTS_CHAR_CAP"],
    ["bedrock", "DOCS_GEN_BEDROCK_FACTS_CHAR_CAP"],
    ["anthropic", "DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP"],
  ])("%s: the warning names that provider's own cap knob (%s)", async (kind, knob) => {
    const result = await synth(kind);
    const truncated = result.warnings.filter((w) => w.kind === "facts-truncated");
    expect(truncated.length).toBeGreaterThan(0);
    for (const w of truncated) expect(w.message).toContain(`${knob}=${CAP}`);
  });

  it("the reporting change does not change what the model reads (same prompts across providers)", async () => {
    // Module selection is provider-independent: capture the section prompts
    // for local and bedrock and require the facts portion to be identical.
    const prompts: Record<string, string[]> = { local: [], bedrock: [] };
    for (const kind of ["local", "bedrock"] as const) {
      const r = router(kind);
      const inner = r.primary.provider.stream.bind(r.primary.provider);
      r.primary.provider.stream = async function* (messages: Array<{ content: unknown }>) {
        const prompt = String(messages.at(-1)?.content);
        if (prompt.includes("Section group:")) prompts[kind].push(prompt);
        yield* inner(messages as never);
      } as AIProvider["stream"];
      await synthesizeFinalDocument(facts, meta, "architecture", "Architecture", r, "p", undefined);
    }
    const factsOf = (p: string) => p.match(/module\d+/g)?.join(",");
    expect(prompts.bedrock.map(factsOf)).toEqual(prompts.local.map(factsOf));
    expect(prompts.bedrock.length).toBeGreaterThan(0);
  });
});
