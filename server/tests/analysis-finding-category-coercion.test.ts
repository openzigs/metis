/**
 * Issue #1222 — an out-of-enum model-authored `category` must keep the finding
 * and leave the drift visible in the logs.
 *
 * Measured live on Bedrock (`us.anthropic.claude-sonnet-5`) against OrderBatch:
 * the `document` and `database` agents emitted `"info"` and `"migration"`,
 * `agentOutputSchema.parse` threw on the enum, and BOTH agents were recorded
 * `failed` with every finding they had produced discarded.
 *
 * These drive the REAL `runAgent` against a provider stub, and assert on the
 * PARSED RESULT rather than on anything downstream — the stub providers accept
 * whatever they are handed, so a test that asserted on downstream behaviour
 * would pass with the coercion removed.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { FINDING_CATEGORIES } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

const { logWarn } = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../src/lib/logger.js", () => ({
  createChildLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: logWarn,
    error: vi.fn(),
  }),
}));

const { collectCoercedFindingCategories, runAgent } =
  await import("../src/lib/analysis/agent-runner.js");

function makeProvider(content: string): AIProvider {
  const response: ChatResponse = {
    content,
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    model: "stub",
    provider: "offline-stub",
  };
  return {
    key: "offline-stub",
    model: "stub",
    offline: true,
    chat: vi.fn(async (_msgs: ChatMessage[]) => response),
    stream: vi.fn(async function* () {
      yield { type: "done" };
    }),
    embed: vi.fn(async () => ({ vectors: [], dimension: 0, model: "stub" })),
    models: vi.fn(async () => ["stub"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

/** The shape the two failing production agents actually returned. */
function outputWithCategories(...categories: unknown[]): string {
  return JSON.stringify({
    summary: "Reviewed the batch schema against the uploaded requirements.",
    findings: categories.map((category, i) => ({
      category,
      severity: "medium",
      title: `Finding ${i}`,
      body: "The requirement adds a retention window but nothing implements it.",
      tags: ["schema"],
      citations: [],
    })),
    notes: [],
  });
}

const RUN_INPUT = {
  agentKey: "database" as const,
  projectName: "OrderBatch",
  projectDescription: "Batch invoicing",
  retrieved: [],
};

beforeEach(() => {
  logWarn.mockClear();
});

describe("runAgent with an out-of-enum finding category (#1222)", () => {
  it("keeps every finding when the model emits `info` and `migration`", async () => {
    const provider = makeProvider(outputWithCategories("info", "migration", "security"));

    const result = await runAgent(provider, RUN_INPUT);

    // The whole agent used to be discarded here. All three findings survive.
    expect(result.output.findings).toHaveLength(3);
    expect(result.output.findings.map((f) => f.category)).toEqual(["other", "other", "security"]);
    // Nothing but the one unrecognised word is lost.
    expect(result.output.findings[0]?.title).toBe("Finding 0");
    expect(result.output.findings[1]?.tags).toEqual(["schema"]);
    expect(result.output.summary).toBe(
      "Reviewed the batch schema against the uploaded requirements.",
    );
  });

  it("logs the ORIGINAL value at warn so the drift stays visible", async () => {
    const provider = makeProvider(outputWithCategories("migration", "architecture", "info"));

    await runAgent(provider, RUN_INPUT);

    const call = logWarn.mock.calls.find(([msg]) => /categor/i.test(String(msg)));
    expect(call, "expected a warn log naming the coerced categories").toBeDefined();
    const meta = call?.[1] as Record<string, unknown>;
    expect(meta.agentKey).toBe("database");
    expect(meta.count).toBe(2);
    expect(meta.coercedTo).toBe("other");
    // The values themselves, not just a count — a count alone cannot tell you
    // whether the prompt needs work or the enum is missing a bucket.
    const originals = JSON.stringify(meta.originals);
    expect(originals).toContain("migration");
    expect(originals).toContain("info");
    // The in-enum finding is not reported.
    expect(originals).not.toContain("architecture");
  });

  it("bounds the sampled values but reports the true count", async () => {
    // This log is built BEFORE `clampAgentOutputStrings` caps `findings` at 50,
    // so the list is bounded only by what the model emitted. `count` must stay
    // truthful while the named values stay bounded.
    const provider = makeProvider(outputWithCategories(...Array(40).fill("migration")));

    await runAgent(provider, RUN_INPUT);

    const meta = logWarn.mock.calls.find(([msg]) => /categor/i.test(String(msg)))?.[1] as Record<
      string,
      unknown
    >;
    expect(meta.count).toBe(40);
    expect(meta.originals).toHaveLength(10);
    expect(meta.truncatedSample).toBe(true);
  });

  it("escapes a model-authored value so it cannot forge a log line", async () => {
    const provider = makeProvider(
      outputWithCategories('bogus"\n  level=error msg="fabricated entry'),
    );

    await runAgent(provider, RUN_INPUT);

    const meta = logWarn.mock.calls.find(([msg]) => /categor/i.test(String(msg)))?.[1] as Record<
      string,
      unknown
    >;
    const rendered = (meta.originals as string[])[0]!;
    expect(rendered).not.toContain("\n");
    expect(rendered).toContain("\\n");
  });

  it("logs NOTHING when every category is already in the enum", async () => {
    const provider = makeProvider(outputWithCategories(...FINDING_CATEGORIES));

    const result = await runAgent(provider, RUN_INPUT);

    expect(result.output.findings.map((f) => f.category)).toEqual([...FINDING_CATEGORIES]);
    expect(logWarn.mock.calls.filter(([msg]) => /categor/i.test(String(msg)))).toHaveLength(0);
  });

  it("does not warn for a category that only needed case normalising", async () => {
    // `Security` is the category the model meant; no fidelity is lost, so this
    // is not drift and must not be reported as such.
    const provider = makeProvider(outputWithCategories("Security", " Compliance "));

    const result = await runAgent(provider, RUN_INPUT);

    expect(result.output.findings.map((f) => f.category)).toEqual(["security", "compliance"]);
    expect(logWarn.mock.calls.filter(([msg]) => /categor/i.test(String(msg)))).toHaveLength(0);
  });

  it("still fails the agent when a finding is structurally invalid", async () => {
    // The coercion must not become a general "make it valid" pass: only the
    // category is relaxed. A missing `title` is still fatal, as before.
    const provider = makeProvider(
      JSON.stringify({
        summary: "s",
        findings: [{ category: "migration", severity: "medium", body: "b" }],
        notes: [],
      }),
    );

    await expect(runAgent(provider, RUN_INPUT)).rejects.toThrow();
  });
});

describe("collectCoercedFindingCategories (#1222)", () => {
  it("reports the index and original of each unrecognised category", () => {
    expect(
      collectCoercedFindingCategories({
        findings: [{ category: "security" }, { category: "migration" }, { category: "info" }],
      }),
    ).toEqual([
      { index: 1, original: "migration" },
      { index: 2, original: "info" },
    ]);
  });

  it("reports a missing or non-string category, which is coerced too", () => {
    expect(
      collectCoercedFindingCategories({ findings: [{ severity: "low" }, { category: 42 }] }),
    ).toEqual([
      { index: 0, original: undefined },
      { index: 1, original: 42 },
    ]);
  });

  it("truncates a pathologically long value so one finding cannot flood the log", () => {
    const long = "x".repeat(5000);
    const [entry] = collectCoercedFindingCategories({ findings: [{ category: long }] });
    expect(typeof entry?.original).toBe("string");
    expect((entry?.original as string).length).toBeLessThanOrEqual(64);
  });

  it.each([[null], [undefined], [42], ["a string"], [[]], [{ findings: "not-an-array" }]])(
    "returns [] for the non-payload %j rather than throwing",
    (input) => {
      expect(collectCoercedFindingCategories(input)).toEqual([]);
    },
  );

  it("skips a non-object entry inside findings", () => {
    expect(
      collectCoercedFindingCategories({ findings: [null, "x", { category: "info" }] }),
    ).toEqual([{ index: 2, original: "info" }]);
  });
});
