/**
 * Epic #1316 (#1318) — the analysis pipeline's claim-level faithfulness metric.
 *
 * These tests pin the four properties the issue's acceptance criteria turn on:
 * the metric reaches analysis through the SHARED substrate (not a third judging
 * stack), it is strictly additive, `null` means unverifiable rather than bad, and
 * it can never reach the categorical gate.
 */
import { describe, expect, it, vi } from "vitest";
import type { Citation } from "@metis/shared";
import type { GroundingContext } from "../docs-gen/grounding/grounding-context.js";
import {
  analysisFaithfulnessMetricEnabled,
  applyFindingFaithfulness,
  scoreFindingFaithfulness,
  toFaithfulnessEvidence,
  toFindingFaithfulness,
  UsageCountingProvider,
} from "./finding-faithfulness.js";
import type { PanelEvidence } from "./support-panel.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";

// ── Doubles ────────────────────────────────────────────────────────────────

function makeProvider(reply = "{}"): AIProvider {
  return {
    key: "anthropic",
    model: "test-model",
    offline: false,
    capabilities: { streaming: true, tools: true, embeddings: false, vision: false },
    chat: vi.fn(
      async (): Promise<ChatResponse> => ({
        content: reply,
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    ),
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(async () => ["test-model"]),
    ping: vi.fn(async () => true),
  } as unknown as AIProvider;
}

/** A claim extractor double: returns one atomic claim per line of the text. */
const extractorOf = (claims: string[]) => ({
  decompose: vi.fn(async (_t: string, _c: GroundingContext) => ({
    claims: claims.map((claim) => ({ claim })),
  })),
});

/** A judge double: `supported` flags, in order, or `null` for "no usable verdict". */
const judgeOf = (supported: boolean[] | null) => ({
  judge: vi.fn(async (claims: string[]) =>
    supported === null ? null : claims.map((claim, i) => ({ claim, supported: supported[i] })),
  ),
});

const EVIDENCE: PanelEvidence[] = [
  {
    filePath: "src/auth/login.ts",
    startLine: 10,
    endLine: 30,
    excerpt: "export function login() {}",
  },
];

const citation = (filePath: string): Citation =>
  ({ type: "code", filePath, startLine: 10, endLine: 30 }) as unknown as Citation;

const FINDING = { title: "Login lacks rate limiting", body: "The login route has no limiter." };

// ── The flag ───────────────────────────────────────────────────────────────

describe("analysisFaithfulnessMetricEnabled", () => {
  it("defaults OFF so a flag-off run is byte-identical to a pre-#1318 run", () => {
    expect(analysisFaithfulnessMetricEnabled({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it.each(["1", "true"])("is on for %s", (v) => {
    expect(
      analysisFaithfulnessMetricEnabled({ ANALYSIS_FAITHFULNESS_METRIC: v } as NodeJS.ProcessEnv),
    ).toBe(true);
  });

  it.each(["0", "false", "yes", ""])("stays off for %s", (v) => {
    expect(
      analysisFaithfulnessMetricEnabled({ ANALYSIS_FAITHFULNESS_METRIC: v } as NodeJS.ProcessEnv),
    ).toBe(false);
  });
});

// ── Pure mappers ───────────────────────────────────────────────────────────

describe("toFindingFaithfulness", () => {
  it("carries a real ratio through unchanged", () => {
    expect(
      toFindingFaithfulness({ faithfulness: 0.5, totalClaims: 4, supportedClaims: 2 }),
    ).toEqual({ score: 0.5, totalClaims: 4, supportedClaims: 2 });
  });

  it("keeps the unverifiable reason beside a null score", () => {
    expect(
      toFindingFaithfulness({
        faithfulness: null,
        totalClaims: 0,
        supportedClaims: 0,
        unverifiableReason: "judge-unavailable",
      }),
    ).toEqual({
      score: null,
      totalClaims: 0,
      supportedClaims: 0,
      unverifiableReason: "judge-unavailable",
    });
  });
});

describe("toFaithfulnessEvidence", () => {
  it("renders a line-ranged excerpt under its file:line locator", () => {
    expect(toFaithfulnessEvidence(EVIDENCE)).toEqual([
      {
        id: "src/auth/login.ts:10-30",
        label: "src/auth/login.ts",
        text: "export function login() {}",
      },
    ]);
  });

  it("falls back to the bare path when the excerpt has no line range", () => {
    expect(toFaithfulnessEvidence([{ filePath: "docs/spec.md#chunk-3", excerpt: "x" }])[0].id).toBe(
      "docs/spec.md#chunk-3",
    );
  });

  it("keeps a start line without an end line", () => {
    expect(toFaithfulnessEvidence([{ filePath: "a.ts", startLine: 7, excerpt: "x" }])[0].id).toBe(
      "a.ts:7",
    );
  });
});

describe("UsageCountingProvider", () => {
  it("accumulates usage across forwarded chats and delegates identity", async () => {
    const inner = makeProvider();
    const counting = new UsageCountingProvider(inner);
    expect(counting.model).toBe("test-model");
    expect(counting.offline).toBe(false);
    expect(counting.key).toBe("anthropic");
    expect(counting.capabilities).toBe(inner.capabilities);
    await counting.chat([{ role: "user", content: "a" }]);
    await counting.chat([{ role: "user", content: "b" }]);
    expect(counting.llmCalls).toBe(2);
    expect(counting.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30 });
    await counting.models();
    await counting.ping();
    expect(inner.models).toHaveBeenCalled();
    expect(inner.ping).toHaveBeenCalled();
  });

  it("delegates stream and embed untouched — only chat is intercepted", () => {
    const inner = makeProvider();
    const counting = new UsageCountingProvider(inner);
    counting.stream([{ role: "user", content: "a" }]);
    counting.embed(["a"]);
    expect(inner.stream).toHaveBeenCalledOnce();
    expect(inner.embed).toHaveBeenCalledWith(["a"]);
    // Neither path may be counted as a judged round-trip.
    expect(counting.llmCalls).toBe(0);
    expect(counting.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });
});

// ── Scoring one finding ────────────────────────────────────────────────────

describe("scoreFindingFaithfulness", () => {
  it("returns null and makes NO provider call when the flag is off", async () => {
    const provider = makeProvider();
    const out = await scoreFindingFaithfulness(
      provider,
      { finding: FINDING, citations: [], evidencePool: EVIDENCE },
      { enabled: false },
    );
    expect(out).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("returns null and makes NO provider call when there is no evidence at all", async () => {
    const provider = makeProvider();
    const out = await scoreFindingFaithfulness(
      provider,
      { finding: FINDING, citations: [], evidencePool: [] },
      { enabled: true },
    );
    expect(out).toBeNull();
    expect(provider.chat).not.toHaveBeenCalled();
  });

  it("scores supported/total over the SAME evidence the panel would select", async () => {
    const extractor = extractorOf(["claim a", "claim b", "claim c", "claim d"]);
    const judge = judgeOf([true, true, true, false]);
    const out = await scoreFindingFaithfulness(
      makeProvider(),
      { finding: FINDING, citations: [citation("src/auth/login.ts")], evidencePool: EVIDENCE },
      { enabled: true, extractor, judge },
    );
    expect(out?.faithfulness).toEqual({ score: 0.75, totalClaims: 4, supportedClaims: 3 });
    // The judge saw the finding's TITLE and BODY, not one or the other: the title
    // alone is the assertion a reader acts on.
    const judged = extractor.decompose.mock.calls[0][0];
    expect(judged).toContain(FINDING.title);
    expect(judged).toContain(FINDING.body);
  });

  it("reports UNVERIFIABLE (null), never 0, when the judge returns no usable verdict", async () => {
    const out = await scoreFindingFaithfulness(
      makeProvider(),
      { finding: FINDING, citations: [], evidencePool: EVIDENCE },
      { enabled: true, extractor: extractorOf(["c1"]), judge: judgeOf(null) },
    );
    expect(out?.faithfulness.score).toBeNull();
    expect(out?.faithfulness.unverifiableReason).toBe("judge-unavailable");
  });

  it("reports UNVERIFIABLE with reason no-claims when nothing decomposes", async () => {
    const out = await scoreFindingFaithfulness(
      makeProvider(),
      { finding: FINDING, citations: [], evidencePool: EVIDENCE },
      { enabled: true, extractor: extractorOf([]), judge: judgeOf([]) },
    );
    expect(out?.faithfulness).toEqual({
      score: null,
      totalClaims: 0,
      supportedClaims: 0,
      unverifiableReason: "no-claims",
    });
  });

  it("restricts the evidence a finding is judged against to what it cites", async () => {
    const extractor = extractorOf(["c1"]);
    const pool: PanelEvidence[] = [
      { filePath: "src/a.ts", excerpt: "AAA" },
      { filePath: "src/b.ts", excerpt: "BBB" },
    ];
    let seen: GroundingContext | undefined;
    extractor.decompose.mockImplementation(async (_t: string, ctx: GroundingContext) => {
      seen = ctx;
      return { claims: [{ claim: "c1" }] };
    });
    await scoreFindingFaithfulness(
      makeProvider(),
      { finding: FINDING, citations: [citation("src/b.ts")], evidencePool: pool },
      { enabled: true, extractor, judge: judgeOf([true]) },
    );
    const seenText = (seen?.sources ?? []).map((s) => s.text).join("\n");
    expect(seenText).toContain("BBB");
    expect(seenText).not.toContain("AAA");
  });
});

// ── Scoring a whole agent pass ─────────────────────────────────────────────

interface TestFinding {
  title: string;
  body: string;
  citations: Citation[];
  verificationStatus?: string | null;
  faithfulness?: unknown;
}

const findingsFixture = (): TestFinding[] => [
  {
    title: "A",
    body: "body a",
    citations: [citation("src/auth/login.ts")],
    verificationStatus: "confirmed",
  },
  { title: "B", body: "body b", citations: [], verificationStatus: "unverified" },
];

describe("applyFindingFaithfulness", () => {
  it("returns findings UNTOUCHED and spends nothing when the flag is off", async () => {
    const provider = makeProvider();
    const input = findingsFixture();
    const out = await applyFindingFaithfulness(provider, input, EVIDENCE, { enabled: false });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(out.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    // ABSENT, not null: a flag-off run must persist byte-identically to pre-#1318.
    for (const f of out.findings) expect("faithfulness" in f).toBe(false);
    expect(out.findings).toEqual(input);
  });

  it("attaches the metric to every finding", async () => {
    const out = await applyFindingFaithfulness(makeProvider(), findingsFixture(), EVIDENCE, {
      enabled: true,
      extractor: extractorOf(["c1", "c2"]),
      judge: judgeOf([true, false]),
    });
    for (const f of out.findings) {
      expect(f.faithfulness).toEqual({ score: 0.5, totalClaims: 2, supportedClaims: 1 });
    }
  });

  /**
   * End-to-end over the REAL `ClaimExtractor` + `FaithfulnessJudge` — i.e. the
   * substrate docs-gen uses, driven by a scripted provider. This is what makes
   * "the same claim-level metric in both pipelines" a wiring fact rather than a
   * comment, and it is the only place the token accounting is observable: a
   * metric whose cost reads zero cannot be traded against its value (#1108).
   */
  it("scores through the REAL docs-gen substrate and folds its token usage", async () => {
    const replies = [
      JSON.stringify({
        claims: [
          { claim: "The login route has no limiter.", sourceIds: [] },
          { claim: "Login lacks rate limiting", sourceIds: [] },
        ],
      }),
      JSON.stringify({
        verdicts: [
          { claim: "The login route has no limiter.", supported: true, sourceIds: [] },
          { claim: "Login lacks rate limiting", supported: false, sourceIds: [] },
        ],
      }),
    ];
    let call = 0;
    const provider = makeProvider();
    (provider.chat as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
      content: replies[Math.min(call++, replies.length - 1)],
      usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
    }));

    const out = await applyFindingFaithfulness(provider, [findingsFixture()[0]], EVIDENCE, {
      enabled: true,
    });
    expect(out.findings[0].faithfulness).toEqual({
      score: 0.5,
      totalClaims: 2,
      supportedClaims: 1,
    });
    // Two round-trips (decompose + judge), both counted.
    expect(out.usage).toEqual({ promptTokens: 200, completionTokens: 40, totalTokens: 240 });
  });

  it("NEVER touches verificationStatus — the categorical verdict is preserved verbatim", async () => {
    const input = findingsFixture();
    const before = input.map((f) => f.verificationStatus);
    const out = await applyFindingFaithfulness(makeProvider(), input, EVIDENCE, {
      enabled: true,
      extractor: extractorOf(["c1"]),
      judge: judgeOf([false]),
    });
    expect(out.findings.map((f) => f.verificationStatus)).toEqual(before);
    // Even a score of 0 leaves a `confirmed` finding confirmed.
    expect(out.findings[0].faithfulness).toEqual({
      score: 0,
      totalClaims: 1,
      supportedClaims: 0,
    });
    expect(out.findings[0].verificationStatus).toBe("confirmed");
  });

  it("leaves a finding UNMEASURED rather than failing the run when scoring throws", async () => {
    const boom = {
      decompose: vi.fn(async () => {
        throw new Error("provider exploded");
      }),
    };
    const out = await applyFindingFaithfulness(makeProvider(), findingsFixture(), EVIDENCE, {
      enabled: true,
      extractor: boom,
      judge: judgeOf([true]),
    });
    expect(out.findings).toHaveLength(2);
    for (const f of out.findings) expect("faithfulness" in f).toBe(false);
  });

  /**
   * Found while wiring the first consumer. `agentFindingPayloadSchema` accepts
   * `faithfulness` as nullish, and the strict-JSON schema that makes it
   * unemittable is only used where the provider supports structured output — so
   * on the plain-Zod path a model could author its own perfect score and have it
   * persisted as a measurement nothing measured.
   */
  it("DROPS a model-authored faithfulness — this field is the server's to write", async () => {
    const modelAuthored = findingsFixture().map((f) => ({
      ...f,
      faithfulness: { score: 1, totalClaims: 99, supportedClaims: 99 },
    }));

    const off = await applyFindingFaithfulness(makeProvider(), modelAuthored, EVIDENCE, {
      enabled: false,
    });
    for (const f of off.findings) expect("faithfulness" in f).toBe(false);

    // …and when the metric runs but cannot score, the field is ABSENT, not the
    // model's number left standing.
    const failed = await applyFindingFaithfulness(makeProvider(), modelAuthored, EVIDENCE, {
      enabled: true,
      extractor: {
        decompose: vi.fn(async () => {
          throw new Error("provider exploded");
        }),
      },
      judge: judgeOf([true]),
    });
    for (const f of failed.findings) expect("faithfulness" in f).toBe(false);

    // …and when it DOES score, the server's number replaces the model's.
    const scored = await applyFindingFaithfulness(makeProvider(), modelAuthored, EVIDENCE, {
      enabled: true,
      extractor: extractorOf(["c1", "c2"]),
      judge: judgeOf([true, false]),
    });
    expect(scored.findings[0].faithfulness).toEqual({
      score: 0.5,
      totalClaims: 2,
      supportedClaims: 1,
    });
  });

  it("PROPAGATES cancellation — an aborted run must stop, not grade on", async () => {
    const controller = new AbortController();
    controller.abort();
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const boom = {
      decompose: vi.fn(async () => {
        throw abortErr;
      }),
    };
    await expect(
      applyFindingFaithfulness(makeProvider(), findingsFixture(), EVIDENCE, {
        enabled: true,
        extractor: boom,
        judge: judgeOf([true]),
        signal: controller.signal,
      }),
    ).rejects.toThrow("aborted");
  });
});
