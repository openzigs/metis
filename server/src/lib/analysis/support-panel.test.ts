/**
 * Epic #1107 (#1109) — the multi-lens support panel driver.
 *
 * The panel is driven through a fake provider that answers PER LENS, so the two
 * properties the epic is built on are asserted rather than assumed: the lenses
 * are independent (no lens's prompt mentions another's verdict), and no vote
 * combination removes a finding.
 */
import { describe, expect, it, vi } from "vitest";
import type { Citation } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { StructuredVerdictMetrics } from "./structured-verdict.js";
import {
  analysisLlmSupportPanelEnabled,
  applySupportPanel,
  buildLensPrompt,
  collectPanelEvidence,
  evidenceFilePaths,
  MAX_PANEL_EVIDENCE_CHARS,
  MAX_PANEL_EVIDENCE_ITEMS,
  renderEvidenceBlock,
  runSupportPanel,
  selectFindingEvidence,
  type PanelEvidence,
} from "./support-panel.js";

const FILE = "server/src/lib/change-analysis/change-analysis-engine.ts";

const EVIDENCE: PanelEvidence[] = [
  {
    filePath: FILE,
    startLine: 128,
    endLine: 146,
    excerpt: "export function computeSeverity(changeType, bodyDelta) { return 'low'; }",
  },
];

const CITATIONS: Citation[] = [{ filePath: FILE, startLine: 128, endLine: 146 }];

const FINDING = {
  title: "No evidence found for drift severity classification",
  body: "No implementation of a severity computation was located, so this is a confirmed gap.",
};

/** Replies keyed by lens, so every voter can be scripted independently. */
class LensProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = true;
  readonly capabilities = { responseFormat: false, nativeToolCalls: false };
  readonly calls: Array<{ messages: ChatMessage[]; opts?: ChatOptions }> = [];

  constructor(private readonly byLens: Record<string, string | Error>) {}

  async chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResponse> {
    this.calls.push({ messages, opts });
    const system = opts?.systemMessage ?? "";
    const lens = system.includes("YOUR LENS: SUPPORT")
      ? "support"
      : system.includes("YOUR LENS: SCOPE")
        ? "scope"
        : "currency";
    const next = this.byLens[lens];
    if (next === undefined) throw new Error(`no script for lens ${lens}`);
    if (next instanceof Error) throw next;
    return {
      content: next,
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      model: this.model,
      provider: this.key,
    };
  }
  async *stream(): AsyncGenerator<never> {
    throw new Error("not used");
  }
  async embed(): Promise<never> {
    throw new Error("not used");
  }
  async models(): Promise<string[]> {
    return [this.model];
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

const reply = (judgement: string, line = 131): string =>
  JSON.stringify({
    judgement,
    citation: `${FILE}:${line}`,
    reasoning: `decided at ${FILE}:${line}`,
  });

const allLenses = (judgement: string): Record<string, string> => ({
  support: reply(judgement),
  scope: reply(judgement),
  currency: reply(judgement),
});

/**
 * #1111 — `FINDING` is absence-shaped ("No evidence found for …"), so the A3
 * absence check would fire a FOURTH provider call on it. These are the #1109
 * LENS tests: they assert the three-lens mechanics, so the absence check is
 * switched off here and exercised on its own in `absence-verification.test.ts`
 * and `support-panel-absence.test.ts`. A test that wants both passes
 * `absenceClaim: true`.
 */
const run = (provider: AIProvider, over: Parameters<typeof runSupportPanel>[2] = {}) =>
  runSupportPanel(
    provider,
    { finding: FINDING, citations: CITATIONS, evidencePool: EVIDENCE },
    { enabled: true, absenceClaim: false, metrics: new StructuredVerdictMetrics(), ...over },
  );

describe("analysisLlmSupportPanelEnabled (#1109 — default OFF)", () => {
  it("is off when the variable is unset", () => {
    expect(analysisLlmSupportPanelEnabled({})).toBe(false);
  });

  it("is off for every value except an explicit opt-in", () => {
    for (const v of ["0", "false", "", "yes", "on"]) {
      expect(analysisLlmSupportPanelEnabled({ ANALYSIS_LLM_SUPPORT_PANEL: v })).toBe(false);
    }
  });

  it("is on for 1 and true", () => {
    expect(analysisLlmSupportPanelEnabled({ ANALYSIS_LLM_SUPPORT_PANEL: "1" })).toBe(true);
    expect(analysisLlmSupportPanelEnabled({ ANALYSIS_LLM_SUPPORT_PANEL: "true" })).toBe(true);
  });
});

describe("collectPanelEvidence", () => {
  it("takes code-graph chunks under their file locator", () => {
    const got = collectPanelEvidence([
      {
        documentId: "code-graph:sym-1",
        chunkIndex: 0,
        filename: "engine.ts",
        text: "code body",
        source: "code-graph",
        filePath: `./${FILE}`,
        startLine: 1,
        endLine: 9,
      },
    ]);
    expect(got).toEqual([{ filePath: FILE, startLine: 1, endLine: 9, excerpt: "code body" }]);
  });

  it("takes DOCUMENT chunks too, under a chunk locator", () => {
    // The #734 gate never validates document citations, so a finding that
    // overstates what a doc says is invisible to every deterministic check.
    const got = collectPanelEvidence([
      { documentId: "doc-1", chunkIndex: 13, filename: "billing-brd.md", text: "prose" },
    ]);
    expect(got).toEqual([
      {
        filePath: "billing-brd.md#chunk-13",
        excerpt: "prose",
        documentId: "doc-1",
        chunkIndex: 13,
      },
    ]);
  });

  it("skips chunks with no text and code-graph chunks with no filePath", () => {
    expect(
      collectPanelEvidence([
        { documentId: "d", chunkIndex: 0, filename: "a.md", text: "" },
        {
          documentId: "code-graph:x",
          chunkIndex: 0,
          filename: "b.ts",
          text: "t",
          source: "code-graph",
        },
      ]),
    ).toEqual([]);
  });

  it("takes read_file_slice tool results and ignores other tools", () => {
    const got = collectPanelEvidence(
      [],
      [
        { tool: "read_file_slice", args: { filePath: FILE }, result: "line one" },
        { tool: "search_code", args: {}, result: "hits" },
        { tool: "read_file_slice", args: {}, result: "no path" },
      ],
    );
    expect(got).toEqual([{ filePath: FILE, excerpt: "line one" }]);
  });

  it("falls back to resultPreview when the full result is absent", () => {
    const got = collectPanelEvidence(
      [],
      [{ tool: "read_file_slice", args: { filePath: FILE }, resultPreview: "preview" }],
    );
    expect(got[0].excerpt).toBe("preview");
  });
});

describe("selectFindingEvidence", () => {
  it("selects only the excerpts for files the finding cites", () => {
    const pool = [...EVIDENCE, { filePath: "other/file.ts", excerpt: "unrelated" }];
    expect(selectFindingEvidence(CITATIONS, pool).map((e) => e.filePath)).toEqual([FILE]);
  });

  it("uses the citation snippet when the pool has nothing for that file", () => {
    const cites: Citation[] = [
      { filePath: "a/b.ts", startLine: 3, endLine: 4, snippet: "const x=1" },
    ];
    expect(selectFindingEvidence(cites, [])).toEqual([
      { filePath: "a/b.ts", startLine: 3, endLine: 4, excerpt: "const x=1" },
    ]);
  });

  it("falls back to the head of the pool for a citation-free (absence) finding", () => {
    // #773's shape: an absence claim cites nothing, so 'is this contradicted by
    // what we retrieved?' is only answerable against the wider retrieved set.
    const pool = Array.from({ length: 20 }, (_, i) => ({ filePath: `f${i}.ts`, excerpt: "x" }));
    expect(selectFindingEvidence([], pool)).toHaveLength(MAX_PANEL_EVIDENCE_ITEMS);
  });

  it("matches a DOCUMENT citation to its chunk excerpt", () => {
    const docCite: Citation[] = [{ documentId: "d1", chunkIndex: 13 }];
    const pool: PanelEvidence[] = [
      { filePath: "other.md#chunk-1", excerpt: "no", documentId: "d1", chunkIndex: 1 },
      { filePath: "billing-brd.md#chunk-13", excerpt: "yes", documentId: "d1", chunkIndex: 13 },
    ];
    expect(selectFindingEvidence(docCite, pool).map((e) => e.excerpt)).toEqual(["yes"]);
  });

  it("falls back to the pool rather than leaving the panel nothing to read", () => {
    // A citation the pool cannot resolve (a chunk pruned from the prompt) must
    // not silently silence the panel for that finding.
    const docCite: Citation[] = [{ documentId: "missing", chunkIndex: 4 }];
    const pool: PanelEvidence[] = [{ filePath: "z.ts", excerpt: "x" }];
    expect(selectFindingEvidence(docCite, pool)).toEqual(pool);
  });
});

describe("renderEvidenceBlock", () => {
  it("renders a locator header per excerpt", () => {
    expect(renderEvidenceBlock(EVIDENCE)).toContain(`--- ${FILE}:128-146 ---`);
  });

  it("bounds the whole block even when handed a huge corpus", () => {
    const huge = Array.from({ length: 40 }, (_, i) => ({
      filePath: `f${i}.ts`,
      excerpt: "y".repeat(5_000),
    }));
    expect(renderEvidenceBlock(huge).length).toBeLessThanOrEqual(MAX_PANEL_EVIDENCE_CHARS + 2_000);
  });

  it("omits the line range when a tool-read excerpt has none", () => {
    expect(renderEvidenceBlock([{ filePath: "a.ts", excerpt: "z" }])).toContain("--- a.ts ---");
  });
});

describe("buildLensPrompt (#1109 — untrusted input, and no lens sees another)", () => {
  it("labels the finding and evidence as untrusted", () => {
    const p = buildLensPrompt("support", FINDING, EVIDENCE);
    expect(p).toContain("=== FINDING (untrusted) ===");
    expect(p).toContain("=== EVIDENCE THE AGENT RETRIEVED (untrusted) ===");
  });

  it("carries only its own lens instruction", () => {
    const p = buildLensPrompt("scope", FINDING, EVIDENCE);
    expect(p).toContain("YOUR LENS: SCOPE");
    expect(p).not.toContain("YOUR LENS: SUPPORT");
    expect(p).not.toContain("YOUR LENS: CURRENCY");
  });

  it("says so when there is no evidence rather than rendering an empty block", () => {
    expect(buildLensPrompt("currency", FINDING, [])).toContain("(no evidence was retrieved");
  });
});

describe("runSupportPanel", () => {
  it("returns null and makes NO provider call when the flag is off", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const panel = await runSupportPanel(
      provider,
      { finding: FINDING, citations: CITATIONS, evidencePool: EVIDENCE },
      { enabled: false },
    );
    expect(panel).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("returns null and costs nothing when there is no evidence to judge", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const panel = await runSupportPanel(
      provider,
      { finding: FINDING, citations: CITATIONS, evidencePool: [] },
      { enabled: true },
    );
    expect(panel).toBeNull();
    expect(provider.calls).toHaveLength(0);
  });

  it("runs one call per lens and aggregates unanimous support to high", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const panel = await run(provider);
    expect(provider.calls).toHaveLength(3);
    expect(panel).toMatchObject({ confidence: "high", countedVotes: 3, supportedVotes: 3 });
    expect(panel?.votes.map((v) => v.lens)).toEqual(["support", "scope", "currency"]);
  });

  it("marks a finding whose evidence exists but does not support its claim as LOW", async () => {
    // The acceptance criterion, and the case the deterministic gate cannot catch:
    // the finding cites (and retrieved) the very file that refutes it.
    const provider = new LensProvider({
      support: reply("unsupported"),
      scope: reply("unsupported"),
      currency: reply("supported"),
    });
    const panel = await run(provider);
    expect(panel?.confidence).toBe("low");
    expect(panel?.unsupportedVotes).toBe(2);
  });

  it("no lens ever sees another lens's prompt or verdict", async () => {
    const provider = new LensProvider(allLenses("supported"));
    await run(provider);
    for (const call of provider.calls) {
      const body = JSON.stringify(call.messages) + (call.opts?.systemMessage ?? "");
      // No transcript may carry another voter's judgement or a consensus request.
      expect(body).not.toMatch(/other (voter|lens)|consensus|the panel (said|decided)/i);
      const lensHeaders = (body.match(/YOUR LENS: [A-Z]+/g) ?? []).map((s) => s);
      expect(new Set(lensHeaders).size).toBe(1);
    }
  });

  it("counts a provider failure as NO SIGNAL, never as a vote against the finding", async () => {
    const provider = new LensProvider({
      support: new Error("upstream 503"),
      scope: reply("supported"),
      currency: reply("supported"),
    });
    const panel = await run(provider);
    expect(panel).toMatchObject({
      confidence: "high",
      noSignalVotes: 1,
      unsupportedVotes: 0,
      countedVotes: 2,
    });
  });

  it("aggregates to no-signal (never low) when every lens degrades", async () => {
    const provider = new LensProvider({
      support: new Error("boom"),
      scope: new Error("boom"),
      currency: new Error("boom"),
    });
    const panel = await run(provider);
    expect(panel).toMatchObject({ confidence: "no-signal", noSignalVotes: 3 });
  });

  it("discards a verdict that cites a file it was never shown", async () => {
    const provider = new LensProvider({
      support: JSON.stringify({
        judgement: "unsupported",
        citation: "invented/file.ts:1",
        reasoning: "invented/file.ts:1",
      }),
      scope: reply("supported"),
      currency: reply("supported"),
    });
    const panel = await run(provider);
    expect(panel?.uncitedVotes).toBe(1);
    expect(panel?.unsupportedVotes).toBe(0);
    expect(panel?.confidence).toBe("high");
  });

  it("reports token usage and call count for cost accounting", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const panel = await run(provider);
    expect(panel?.usage).toEqual({ promptTokens: 300, completionTokens: 60, llmCalls: 3 });
  });

  it("buckets #1114 metrics per lens so a bad lens prompt is attributable", async () => {
    const metrics = new StructuredVerdictMetrics();
    await run(new LensProvider(allLenses("supported")), { metrics });
    expect(
      metrics
        .allSnapshots()
        .map((s) => s.label)
        .sort(),
    ).toEqual(["support-panel:currency", "support-panel:scope", "support-panel:support"]);
  });

  it("honours a narrowed lens list", async () => {
    const provider = new LensProvider({ support: reply("unsupported") });
    const panel = await run(provider, { lenses: ["support"] });
    expect(provider.calls).toHaveLength(1);
    expect(panel).toMatchObject({ confidence: "low", countedVotes: 1 });
  });
});

describe("applySupportPanel (#1109 — never fails a run, never drops a finding)", () => {
  const findings = [
    { ...FINDING, citations: CITATIONS },
    { title: "Second", body: "Another claim", citations: CITATIONS },
  ];

  it("is a no-op that makes no provider call when the flag is off", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const out = await applySupportPanel(provider, findings, EVIDENCE, { enabled: false });
    expect(provider.calls).toHaveLength(0);
    expect(out.findings).toEqual(findings);
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    // Byte-identical: no `supportPanel` key is introduced at all when off.
    expect(Object.keys(out.findings[0])).not.toContain("supportPanel");
  });

  it("labels every finding and sums usage for the agent's accounting", async () => {
    const provider = new LensProvider(allLenses("supported"));
    const out = await applySupportPanel(provider, findings, EVIDENCE, {
      enabled: true,
      absenceClaim: false,
      metrics: new StructuredVerdictMetrics(),
    });
    expect(out.findings).toHaveLength(2);
    expect(out.findings.every((f) => f.supportPanel?.confidence === "high")).toBe(true);
    expect(out.usage.totalTokens).toBe(720);
  });

  it("keeps EVERY finding even when all lenses say unsupported", async () => {
    // The epic's central constraint: no vote combination deletes a finding.
    const provider = new LensProvider(allLenses("unsupported"));
    const out = await applySupportPanel(provider, findings, EVIDENCE, {
      enabled: true,
      absenceClaim: false,
      metrics: new StructuredVerdictMetrics(),
    });
    expect(out.findings).toHaveLength(findings.length);
    expect(out.findings.map((f) => f.title)).toEqual(findings.map((f) => f.title));
    expect(out.findings.every((f) => f.supportPanel?.confidence === "low")).toBe(true);
  });

  it("swallows an unexpected panel error and keeps the deterministic label", async () => {
    const broken = {
      chat: vi.fn(async () => {
        throw new Error("kaboom");
      }),
    } as unknown as AIProvider;
    // Force a non-degradable failure by making the outcome itself throw.
    const spy = vi
      .spyOn(await import("./structured-verdict.js"), "requestStructuredVerdict")
      .mockRejectedValue(new Error("unexpected"));
    const out = await applySupportPanel(broken, findings, EVIDENCE, { enabled: true });
    spy.mockRestore();
    expect(out.findings).toHaveLength(2);
    expect(out.findings.every((f) => f.supportPanel === undefined)).toBe(true);
  });

  it("propagates cancellation instead of grading a cancelled run as no-signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new LensProvider(allLenses("supported"));
    await expect(
      applySupportPanel(provider, findings, EVIDENCE, { enabled: true, signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe("evidenceFilePaths", () => {
  it("dedupes the allow-list a lens's own citation is grounded against", () => {
    expect(
      evidenceFilePaths([
        { filePath: "a.ts", excerpt: "1" },
        { filePath: "a.ts", excerpt: "2" },
        { filePath: "b.ts", excerpt: "3" },
      ]),
    ).toEqual(["a.ts", "b.ts"]);
  });
});
