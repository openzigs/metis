/**
 * DOCS_GEN_GROUNDING (on | sample | off), end to end through the real
 * synthesis loop with the REAL ClaimExtractor and FaithfulnessJudge over a fake
 * provider, on a business-requirements document — which has both single-call
 * sections (Overview, Capabilities, Integrations) and batched ones (Rules,
 * Workflows, Calculations, Data Model), so both grounding paths are exercised
 * in one run.
 *
 * The fake model writes each section as passages of two statement lines; claim
 * decomposition returns one claim per statement line; the judge supports every
 * claim except the second line of each passage in the Rules section (so Rules
 * falls below its literal bar and the narrative sections clear theirs).
 * No network, no database, no live model.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../finops/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../finops/index.js")>();
  return { ...actual, recordUsage: vi.fn() };
});

import type { AIProvider, ChatChunk, ChatMessage, ChatOptions } from "../ai/types.js";
import type { GroundingContext } from "./grounding/grounding-context.js";
import {
  docsGenTuning,
  sectionGroupsFor,
  synthesizeFinalDocument,
  verifiedSectionSupport,
  type ModuleFacts,
  type Phase2ProviderBundle,
  type Phase2Router,
} from "./holistic-synthesizer.js";

// ── Fixture ───────────────────────────────────────────────────────────────

const pad = (n: number, seed: string): string =>
  `${seed} ${"the request is validated against the configured policy and rejected otherwise ".repeat(Math.ceil(n / 80) + 1)}`.slice(
    0,
    n,
  );

function mod(name: string): ModuleFacts {
  const bullets = (kind: string, n: number) =>
    Array.from({ length: n }, (_, i) => `- ${pad(108, `${kind} ${i} of ${name}:`)}`).join("\n");
  return {
    modulePath: `src/${name}`,
    moduleName: name,
    classCount: 1,
    methodCount: 4,
    facts: [
      "PURPOSE",
      `${name} handles one business capability.`,
      "RULES",
      bullets("rule", 20),
      "WORKFLOWS",
      bullets("step", 12),
      "FORMULAS",
      bullets("formula", 4),
      "ENTITIES",
      bullets("entity", 3),
      "NOTES",
      pad(1_500, `notes for ${name}`),
    ].join("\n"),
    formulas: [],
    topClasses: [],
  };
}

const FACTS = Array.from({ length: 4 }, (_, i) => mod(`p${i}`));
const META = { name: "Fixture", totalFiles: 4, totalSymbols: 40, language: "typescript" } as never;
const GROUPS = sectionGroupsFor("business-requirements");
const RULES = GROUPS.find((g) => g.id === "rules")!;
const BATCHED_LABELS = new Set(GROUPS.filter((g) => g.batched).map((g) => g.label));
const PASSAGES_PER_REPLY = 16;

function ragGrounding(): GroundingContext {
  return {
    sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "doc", text: "retrieved evidence" }],
    sourceIds: new Set(["rag:doc:0"]),
    isEmpty: false,
  } as unknown as GroundingContext;
}

// ── Fake model ────────────────────────────────────────────────────────────

interface Log {
  /** Every section-writing prompt, in order. */
  streams: string[];
  /** Every grounding chat call, byte for byte (messages + options). */
  chats: string[];
  /** Passages sent to claim decomposition. */
  decomposed: string[];
  /** Claims sent to the judge, per judge call. */
  judged: string[][];
}

function fakeModel(passagesPerReply: number): AIProvider & { log: Log } {
  const log: Log = { streams: [], chats: [], decomposed: [], judged: [] };
  let replyNo = 0;
  const p = {
    key: "anthropic",
    model: "fake-section-model",
    offline: false,
    log,
    async *stream(messages: ChatMessage[]): AsyncGenerator<ChatChunk> {
      const user = String(messages[messages.length - 1].content);
      log.streams.push(user);
      const label = /Section group: \*\*(.+?)\*\*/.exec(user)?.[1] ?? "?";
      const modules = [...user.matchAll(/^### MODULE: (\S+)/gm)].map((m) => m[1]).join("+");
      const tag = `${label} ${modules || "all"} r${replyNo++}`;
      // ~110-character statements, two per passage: a realistic claim density.
      const passages = Array.from({ length: passagesPerReply }, (_, i) => {
        const heading = i % 4 === 0 ? `### Topic ${i / 4}\n\n` : "";
        return (
          `${heading}Statement ${i}a of ${tag} holds whenever the configured policy applies.\n` +
          `Statement ${i}b of ${tag} also holds for every request that is validated.`
        );
      });
      yield { type: "delta", content: `## ${label}\n\n${passages.join("\n\n")}` };
      yield { type: "done", finishReason: "stop" };
    },
    async chat(messages: ChatMessage[], opts: ChatOptions = {}) {
      log.chats.push(JSON.stringify({ messages, opts: { ...opts, signal: undefined } }));
      const user = String(messages[messages.length - 1].content);
      if (String(messages[0].content).includes("strict faithfulness judge")) {
        const block = user.slice(
          user.indexOf("=== CLAIMS TO JUDGE"),
          user.indexOf("=== END CLAIMS"),
        );
        const claims = [...block.matchAll(/^\d+\. (.+)$/gm)].map((m) => m[1]);
        log.judged.push(claims);
        return {
          content: JSON.stringify({
            verdicts: claims.map((claim) => ({
              claim,
              // The second line of every Rules passage is unsupported (50% < 80%).
              supported: !(claim.includes(RULES.label) && /\d+b of/.test(claim)),
              sourceIds: [],
            })),
          }),
          finishReason: "stop",
        };
      }
      const passage = user.slice(
        user.indexOf("=== PASSAGE ===\n") + "=== PASSAGE ===\n".length,
        user.indexOf("\n=== END PASSAGE ==="),
      );
      log.decomposed.push(passage);
      const claims = passage
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("Statement "))
        .map((claim) => ({ claim, sourceIds: [] }));
      return { content: JSON.stringify({ claims }), finishReason: "stop" };
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
  return p as unknown as AIProvider & { log: Log };
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
  return { primary: bundle };
}

async function run(mode?: string, rate?: string, passagesPerReply = PASSAGES_PER_REPLY) {
  if (mode !== undefined) vi.stubEnv("DOCS_GEN_GROUNDING", mode);
  if (rate !== undefined) vi.stubEnv("DOCS_GEN_GROUNDING_SAMPLE_RATE", rate);
  const provider = fakeModel(passagesPerReply);
  const result = await synthesizeFinalDocument(
    FACTS,
    META,
    "business-requirements",
    "BRD",
    routerFor(provider),
    "p1",
    ragGrounding(),
    undefined,
    undefined,
    undefined,
    { effectiveConfigHash: "cfg" },
  );
  return { result, log: provider.log };
}

const judgeCallsClaims = (log: Log) => log.judged.flat().length;
const allClaims = (log: Log) => log.decomposed.flatMap((p) => p.match(/^Statement .+$/gm) ?? []);

beforeEach(() => {
  vi.stubEnv("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS", "4096");
  vi.stubEnv("DOCS_GEN_JUDGE_ESCALATION", "0");
  vi.stubEnv("DOCS_GEN_GROUNDING", "");
  vi.stubEnv("DOCS_GEN_GROUNDING_SAMPLE_RATE", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

// ── on ────────────────────────────────────────────────────────────────────

describe("DOCS_GEN_GROUNDING=on (the default)", () => {
  it("fixture sanity: both paths run — Rules is written in more than one batch", async () => {
    const { log } = await run();
    const rulesCalls = log.streams.filter((u) => u.includes(`Section group: **${RULES.label}**`));
    expect(rulesCalls.length).toBeGreaterThan(1);
    expect(log.streams.length).toBeGreaterThan(GROUPS.length);
  });

  it("unset, 'on' and an invalid value make byte-identical grounding calls", async () => {
    const unset = await run();
    const on = await run("on");
    const invalid = await run("partial");
    expect(on.log.chats).toEqual(unset.log.chats);
    expect(invalid.log.chats).toEqual(unset.log.chats);
    expect(on.result.warnings).toEqual(unset.result.warnings);
    // Every statement of every reply is decomposed, and every claim judged.
    const decomposed = allClaims(unset.log);
    expect(decomposed).toHaveLength(unset.log.streams.length * PASSAGES_PER_REPLY * 2);
    expect(unset.log.judged.flat()).toEqual(decomposed);
  });

  it("records nothing new: no grounding mode in the result, no grounding-* warning, config hash unchanged", async () => {
    const unset = await run();
    const on = await run("on");
    expect(unset.result.grounding).toBeUndefined();
    expect(unset.result.warnings.some((w) => w.kind.startsWith("grounding-"))).toBe(false);
    expect(unset.result.warnings.some((w) => w.sampled)).toBe(false);
    const cfg = (r: typeof unset.result) =>
      r.sectionSynthesis!.records.map((rec) => rec.inputs.config);
    expect(cfg(on.result)).toEqual(cfg(unset.result));
    // Rules still fails its bar with the usual (unsampled) warning.
    const rules = unset.result.warnings.find((w) => w.section === RULES.label)!;
    expect(rules.kind).toBe("section-ungrounded");
    expect(rules.message).not.toContain("DOCS_GEN_GROUNDING");
  });
});

// ── off ───────────────────────────────────────────────────────────────────

describe("DOCS_GEN_GROUNDING=off", () => {
  it("makes zero claim-extraction and zero judge calls", async () => {
    const { log } = await run("off");
    expect(log.chats).toEqual([]);
    expect(log.decomposed).toEqual([]);
    expect(log.judged).toEqual([]);
  });

  it("writes every section exactly as in `on` mode", async () => {
    const on = await run("on");
    const off = await run("off");
    expect(off.log.streams).toEqual(on.log.streams);
    expect(off.result.markdown.replace(/\d{4}-\d{2}-\d{2}/, "")).toEqual(
      on.result.markdown.replace(/\d{4}-\d{2}-\d{2}/, ""),
    );
  });

  it("marks every section not fact-checked, batched and single-call alike, and records the mode", async () => {
    const { result } = await run("off");
    const skipped = result.warnings.filter((w) => w.kind === "grounding-skipped");
    expect(skipped.map((w) => w.section).sort()).toEqual(GROUPS.map((g) => g.label).sort());
    for (const w of skipped) {
      expect(w.severity).toBe("warning");
      expect(w.message).toContain("NOT fact-checked");
      expect(w.ratio).toBeUndefined();
    }
    expect(result.warnings.some((w) => w.kind === "section-ungrounded")).toBe(false);
    expect(result.grounding).toEqual({ mode: "off" });
    // No score is recorded for any section.
    expect(result.sectionSynthesis!.records.every((r) => r.score === null)).toBe(true);
  });

  it("never reuses a section across modes: the section config hash differs from `on`", async () => {
    const on = await run("on");
    const off = await run("off");
    const cfg = (r: typeof on.result) =>
      r.sectionSynthesis!.records.map((rec) => rec.inputs.config);
    for (const [a, b] of cfg(on.result).map((c, i) => [c, cfg(off.result)[i]])) {
      expect(a).not.toBe(b);
    }
  });
});

// ── sample ────────────────────────────────────────────────────────────────

describe("DOCS_GEN_GROUNDING=sample", () => {
  it("decomposes and judges only a sample, far fewer claims than `on`, and never more calls", async () => {
    const on = await run("on");
    const sample = await run("sample");
    const judgedOn = on.log.judged.flat().length;
    const judgedSample = sample.log.judged.flat().length;
    expect(judgedSample).toBeLessThan(judgedOn * 0.5);
    expect(allClaims(sample.log).length).toBeLessThan(allClaims(on.log).length * 0.5);
    // The judge receives exactly the sampled claims — nothing else.
    expect(sample.log.judged.flat()).toEqual(allClaims(sample.log));
    // Small replies: one decomposition + one judge call either way.
    expect(sample.log.chats.length).toBeLessThanOrEqual(on.log.chats.length);
    // Section writing is unchanged.
    expect(sample.log.streams).toEqual(on.log.streams);
  });

  it("on large replies cuts BOTH decomposition and judge calls (passage sampling)", async () => {
    const on = await run("on", undefined, 160);
    const sample = await run("sample", undefined, 160);
    const judgeCalls = (log: Log) => log.judged.length;
    const decomposeCalls = (log: Log) => log.decomposed.length;
    const decomposedChars = (log: Log) => log.decomposed.join("").length;
    // Measured on this fixture (8 replies of ~36K chars, 320 claims each):
    // on = 64 decomposition + 64 judge calls over 2,560 claims;
    // sample (25%) = 24 decomposition + 16 judge calls over 640 claims.
    expect(judgeCallsClaims(sample.log)).toBeLessThanOrEqual(judgeCallsClaims(on.log) * 0.3);
    expect(decomposeCalls(sample.log)).toBeLessThanOrEqual(decomposeCalls(on.log) / 2);
    expect(judgeCalls(sample.log)).toBeLessThanOrEqual(judgeCalls(on.log) / 3);
    expect(decomposedChars(sample.log)).toBeLessThan(decomposedChars(on.log) * 0.4);
  });

  it("is deterministic: a re-run sends byte-identical grounding calls", async () => {
    const a = await run("sample");
    const b = await run("sample");
    expect(b.log.chats).toEqual(a.log.chats);
  });

  it("judges at least 10 claims for every section, batched ones included", async () => {
    const { log } = await run("sample");
    for (const group of GROUPS) {
      const judged = log.judged.flat().filter((c) => c.includes(` ${group.label} `));
      expect(judged.length, group.label).toBeGreaterThanOrEqual(10);
    }
  });

  it("shares the claim minimum across a batched section's replies instead of applying it per batch", async () => {
    const { log } = await run("sample");
    const judgedFor = (label: string) =>
      log.judged.flat().filter((c) => c.includes(` ${label} `)).length;
    const rulesReplies = log.streams.filter((u) =>
      u.includes(`Section group: **${RULES.label}**`),
    ).length;
    expect(rulesReplies).toBe(2);
    // A single-call section of the same reply size, for scale.
    const single = judgedFor("Overview & Domain");
    expect(judgedFor(RULES.label)).toBeGreaterThanOrEqual(10);
    expect(judgedFor(RULES.label)).toBeLessThan(single * rulesReplies);
  });

  it("spreads the sample across each reply, not just its first passages", async () => {
    const { log } = await run("sample");
    const overview = log.judged.flat().filter((c) => c.includes(" Overview & Domain "));
    const indices = overview.map((c) => Number(/Statement (\d+)/.exec(c)![1]));
    expect(Math.min(...indices)).toBeLessThan(PASSAGES_PER_REPLY / 4);
    expect(Math.max(...indices)).toBeGreaterThanOrEqual((PASSAGES_PER_REPLY * 3) / 4);
  });

  it("labels every score as sampled: a grounding-sampled warning above the bar, a marked tier warning below it", async () => {
    const { result } = await run("sample");
    for (const group of GROUPS) {
      const ws = result.warnings.filter((w) => w.section === group.label);
      expect(ws, group.label).toHaveLength(1);
      expect(ws[0].sampled, group.label).toBe(true);
    }
    const rules = result.warnings.find((w) => w.section === RULES.label)!;
    expect(rules.kind).toBe("section-ungrounded");
    expect(rules.tier).toBe("literal");
    expect(rules.message).toMatch(/^\[Spot-check only \(DOCS_GEN_GROUNDING=sample\)/);
    const overview = result.warnings.find((w) => w.section === "Overview & Domain")!;
    expect(overview.kind).toBe("grounding-sampled");
    expect(overview.message).toContain("not a full verification");
    expect(overview.ratio).toBe(1);
    // The recorded section scores carry their sample coverage.
    for (const rec of result.sectionSynthesis!.records) {
      const s = rec.score!.result.sampled!;
      expect(s.passagesChecked).toBeLessThan(s.passagesTotal);
      expect(s.rate).toBe(0.25);
    }
    expect(result.grounding).toEqual({ mode: "sample", sampleRate: 0.25, minClaims: 10 });
    expect(BATCHED_LABELS.size).toBeGreaterThan(0);
  });

  it("never reports a sampled score as a verified section-level support score (eval harness)", async () => {
    const on = await run("on");
    const sample = await run("sample");
    const support = (r: typeof on.result) => verifiedSectionSupport(r.sections, r.sectionSynthesis);
    expect(support(on.result)).toHaveLength(GROUPS.length);
    expect(support(sample.result)).toEqual([]);
  });

  it("honours DOCS_GEN_GROUNDING_SAMPLE_RATE and records it", async () => {
    const quarter = await run("sample", "0.25");
    const half = await run("sample", "0.5");
    expect(half.log.judged.flat().length).toBeGreaterThan(quarter.log.judged.flat().length);
    expect(half.result.grounding).toEqual({ mode: "sample", sampleRate: 0.5, minClaims: 10 });
  });
});
