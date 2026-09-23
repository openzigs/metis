/**
 * #152 — a grounding reply cut off at the output cap.
 *
 * Run 7 (2026-09-23, gemma3:12b): the 30,713-character Formulas section's claim
 * extraction ran 3m53s, stopped at the 8,192-token cap with the JSON cut
 * mid-array, was logged as "ignored json_schema", was re-asked in json_object
 * mode (cut off the same way), and the operator was told to set json_object.
 *
 * The provider doubles here report `finishReason: "length"` exactly as the
 * OpenAI-compatible adapter does when `max_tokens` stops a reply.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../../ai/types.js";
import {
  ClaimExtractor,
  DEFAULT_CLAIM_BATCH_CHARS,
  splitForClaimExtraction,
} from "./claim-extractor.js";
import { FaithfulnessJudge } from "./faithfulness-judge.js";
import { scoreFaithfulness } from "./citation-validator.js";
import { groundingUnparseableWarning } from "./degraded-warnings.js";
import { buildGroundingContext } from "./grounding-context.js";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
} from "./structured-output-schemas.js";

const ctx = buildGroundingContext({
  ragChunks: [
    { documentId: "doc1", chunkId: "c1", filename: "Premium.sas", text: "premium = base * rate;" },
  ],
});

interface Call {
  messages: ChatMessage[];
  opts: ChatOptions;
}

/** Every call is cut off at the cap: a JSON prefix and `finishReason: "length"`. */
function alwaysTruncated(content = '{"claims":[{"claim":"The premium is base times') {
  const calls: Call[] = [];
  const provider = {
    key: "local-gemma",
    model: "gemma3:12b",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
      calls.push({ messages, opts });
      return {
        content,
        finishReason: "length",
        usage: { promptTokens: 1, completionTokens: 8192, totalTokens: 8193 },
      };
    }),
  } as unknown as AIProvider;
  return { provider, calls };
}

/**
 * A model that answers one claim per passage line with the source id attached,
 * and is stopped by `maxTokens` like a real runtime: when the full reply would
 * exceed the cap (≈4 characters per token) it returns the prefix that fits and
 * `finishReason: "length"`.
 */
function cappedModel() {
  const calls: Call[] = [];
  const provider = {
    key: "local-gemma",
    model: "gemma3:12b",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[], opts: ChatOptions = {}) => {
      calls.push({ messages, opts });
      const user = String(messages[1].content);
      const passage = user.split("=== PASSAGE ===\n")[1].split("\n=== END PASSAGE ===")[0];
      const claims = passage
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("#"))
        .map((l) => ({ claim: l.replace(/^[-*]\s+/, ""), sourceIds: ["rag:doc1:c1"] }));
      const full = JSON.stringify({ claims });
      const capChars = (opts.maxTokens ?? 8192) * 4;
      if (full.length > capChars) {
        return {
          content: full.slice(0, capChars),
          finishReason: "length",
          usage: { promptTokens: 1, completionTokens: opts.maxTokens ?? 8192, totalTokens: 1 },
        };
      }
      return {
        content: full,
        finishReason: "stop",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }),
  } as unknown as AIProvider;
  return { provider, calls };
}

/** A ~30k-character, formula-heavy section in the shape of run 7's Formulas. */
function formulasSection(): { markdown: string; claimLines: string[] } {
  const claimLines: string[] = [];
  const parts: string[] = ["## Formulas", ""];
  let sub = 0;
  let i = 0;
  while (parts.join("\n").length < 30_700) {
    if (i % 25 === 0) {
      sub++;
      parts.push(`### Rating step ${sub}`, "");
    }
    const line =
      `The tier-${i} premium P${i} = base_${i} × (1 + r${i})^n${i} − d${i}, ` +
      `where r${i} = 0.0${(i % 9) + 1}5 and d${i} = min(0.1·P${i}, 250).`;
    claimLines.push(line);
    parts.push(`- ${line}`);
    if (i % 5 === 4) parts.push("");
    i++;
  }
  return { markdown: parts.join("\n"), claimLines };
}

describe("ClaimExtractor — a reply cut off at the output cap (#152)", () => {
  it("is not retried in json_object mode and is reported as truncated", async () => {
    const { provider, calls } = alwaysTruncated();
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
    });
    const result = await extractor.decompose("The premium is base times rate.", ctx);
    expect(calls).toHaveLength(1);
    expect(calls.map((c) => c.opts.responseFormat?.type)).toEqual(["json_schema"]);
    expect(result).toEqual({ claims: [], unparseable: true, truncated: true });
  });

  it("checks finishReason before parsing: a cut-off reply that happens to parse is not trusted", async () => {
    // The JSON closed exactly at the cap, so it parses — but the model was
    // stopped, and the claim list it would have continued is incomplete.
    const { provider, calls } = alwaysTruncated(
      '{"claims":[{"claim":"The premium is base times rate.","sourceIds":[]}]}',
    );
    const extractor = new ClaimExtractor({ provider });
    const result = await extractor.decompose("The premium is base times rate.", ctx);
    expect(calls).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.claims).toEqual([]);
  });

  it("a 30k-char formula-heavy section yields a COMPLETE claim set within an 8,192-token cap", async () => {
    const { markdown, claimLines } = formulasSection();
    expect(markdown.length).toBeGreaterThan(30_000);
    const { provider, calls } = cappedModel();
    const extractor = new ClaimExtractor({ provider, maxTokens: 8192 });
    const result = await extractor.decompose(markdown, ctx);
    expect(result.unparseable).toBeUndefined();
    expect(result.truncated).toBeUndefined();
    expect(result.claims.map((c) => c.claim)).toEqual(claimLines);
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.opts.maxTokens).toBe(8192);
      const passage = String(c.messages[1].content).split("=== PASSAGE ===\n")[1];
      expect(passage.length).toBeLessThanOrEqual(DEFAULT_CLAIM_BATCH_CHARS + 100);
    }
  });

  it("a batch that is still cut off is split and re-asked, never re-sent whole", async () => {
    const { markdown, claimLines } = formulasSection();
    const { provider, calls } = cappedModel();
    // One batch holds the whole section, so the first reply is cut off.
    const extractor = new ClaimExtractor({ provider, maxTokens: 8192, batchChars: 100_000 });
    const result = await extractor.decompose(markdown, ctx);
    expect(result.claims.map((c) => c.claim)).toEqual(claimLines);
    const sizes = calls.map((c) => String(c.messages[1].content).length);
    // The first ask was the whole section; no later ask repeats that size.
    expect(sizes.slice(1).every((s) => s < sizes[0])).toBe(true);
  });

  it("a section under the batch budget is still ONE call", async () => {
    const { provider, calls } = cappedModel();
    const extractor = new ClaimExtractor({ provider, maxTokens: 8192 });
    const result = await extractor.decompose("- Invoices over 1000 need approval.", ctx);
    expect(calls).toHaveLength(1);
    expect(result.claims).toHaveLength(1);
  });

  it("stops at the first batch that stays unparseable instead of spending the rest", async () => {
    const { markdown } = formulasSection();
    const { provider, calls } = alwaysTruncated();
    // Tiny cap: every batch — and every split of it — is cut off.
    const extractor = new ClaimExtractor({ provider });
    const result = await extractor.decompose(markdown, ctx);
    expect(result).toEqual({ claims: [], unparseable: true, truncated: true });
    const batches = splitForClaimExtraction(markdown, DEFAULT_CLAIM_BATCH_CHARS);
    // Only the first batch (and its splits) were asked; the others never were.
    const asked = calls.map((c) => String(c.messages[1].content));
    expect(asked.some((u) => u.includes(batches[1].slice(0, 80)))).toBe(false);
  });

  it("a later batch in json_object mode stays in json_object once json_schema was ignored", async () => {
    const { markdown } = formulasSection();
    const formats: string[] = [];
    const provider = {
      key: "local-gemma",
      offline: false,
      chat: vi.fn(async (_m: ChatMessage[], opts: ChatOptions = {}) => {
        formats.push(opts.responseFormat?.type ?? "off");
        return opts.responseFormat?.type === "json_object"
          ? { content: '{"claims":[{"claim":"x","sourceIds":[]}]}', finishReason: "stop" }
          : { content: "prose", finishReason: "stop" };
      }),
    } as unknown as AIProvider;
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
    });
    const result = await extractor.decompose(markdown, ctx);
    expect(result.unparseable).toBeUndefined();
    expect(formats[0]).toBe("json_schema");
    expect(formats.slice(1).every((f) => f === "json_object")).toBe(true);
    expect(formats.filter((f) => f === "json_schema")).toHaveLength(1);
  });
});

describe("splitForClaimExtraction (#152)", () => {
  it("returns the text unchanged when it fits", () => {
    expect(splitForClaimExtraction("a\n\nb", 100)).toEqual(["a\n\nb"]);
  });

  it("keeps every chunk within the budget and loses no line", () => {
    const { markdown } = formulasSection();
    const chunks = splitForClaimExtraction(markdown, 4_000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4_000);
    const lines = (s: string) => s.split("\n").filter((l) => l.trim().length > 0);
    expect(chunks.flatMap(lines)).toEqual(lines(markdown));
  });

  it("starts a new chunk at a heading rather than mid-subsection when it can", () => {
    const text = ["### A", "", "a1", "a2", "", "### B", "", "b1", "b2"].join("\n");
    const chunks = splitForClaimExtraction(text, 20);
    expect(chunks[1].startsWith("### B")).toBe(true);
  });

  it("never splits inside a fenced block", () => {
    const fence = ["```", "x = 1", "", "y = 2", "", "z = 3", "```"].join("\n");
    const text = `Intro line.\n\n${fence}\n\nOutro line.`;
    const chunks = splitForClaimExtraction(text, 15);
    expect(chunks.some((c) => c.includes(fence))).toBe(true);
  });

  it("never splits a fence that follows its lead-in line without a blank line", () => {
    const fence = ["```", "a = 1", "b = 2", "c = 3", "```"].join("\n");
    const block = `Formula:\n${fence}`;
    const chunks = splitForClaimExtraction(`Intro line.\n\n${block}`, 20);
    expect(chunks.some((c) => c.includes(fence))).toBe(true);
  });

  it("splits one oversized paragraph by line", () => {
    const para = Array.from({ length: 10 }, (_, i) => `line ${i} of a long paragraph`).join("\n");
    const chunks = splitForClaimExtraction(para, 70);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(70);
  });

  it("a non-positive budget returns the whole text", () => {
    expect(splitForClaimExtraction("a\n\nb", 0)).toEqual(["a\n\nb"]);
  });
});

describe("FaithfulnessJudge — a verdict reply cut off at the output cap (#152)", () => {
  it("json_schema: is not retried in json_object mode and is counted as truncated", async () => {
    const { provider, calls } = alwaysTruncated('{"verdicts":[{"claim":"The premium');
    const judge = new FaithfulnessJudge({
      provider,
      responseFormat: FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
    });
    const diagnostics = { batches: 0, unparseableBatches: 0, truncatedBatches: 0 };
    const verdicts = await judge.judge(
      ["The premium is base times rate."],
      ctx,
      undefined,
      diagnostics,
    );
    expect(verdicts).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.responseFormat?.type).toBe("json_schema");
    expect(diagnostics).toEqual({ batches: 1, unparseableBatches: 1, truncatedBatches: 1 });
  });

  it("structured output off: a cut-off batch is not re-sent the same way either", async () => {
    const { provider, calls } = alwaysTruncated('{"verdicts":[');
    const judge = new FaithfulnessJudge({ provider });
    const diagnostics = { batches: 0, unparseableBatches: 0, truncatedBatches: 0 };
    await judge.judge(["The premium is base times rate."], ctx, undefined, diagnostics);
    expect(calls).toHaveLength(1);
    expect(diagnostics.truncatedBatches).toBe(1);
  });

  it("a cut-off reply that parses is still not scored", async () => {
    const { provider } = alwaysTruncated(
      '{"verdicts":[{"claim":"The premium is base times rate.","supported":true,"sourceIds":[]}]}',
    );
    const judge = new FaithfulnessJudge({ provider });
    const verdicts = await judge.judge(["The premium is base times rate."], ctx);
    expect(verdicts).toBeNull();
  });
});

describe("scoreFaithfulness carries the truncation cause (#152)", () => {
  it("claims: a truncated decomposition is reported as truncated", async () => {
    const result = await scoreFaithfulness("Formulas", "text", ctx, {
      extractor: {
        decompose: async () => ({
          claims: [],
          unparseable: true as const,
          truncated: true as const,
        }),
      },
      judge: { judge: async () => null },
    });
    expect(result.unparseable).toBe("claims");
    expect(result.truncated).toBe(true);
  });

  it("verdicts: a truncated judge batch is reported as truncated", async () => {
    const result = await scoreFaithfulness("Formulas", "text", ctx, {
      extractor: { decompose: async () => ({ claims: [{ claim: "c", sourceIds: [] }] }) },
      judge: {
        judge: async (_c, _x, _s, d) => {
          if (d) {
            d.batches = 1;
            d.unparseableBatches = 1;
            d.truncatedBatches = 1;
          }
          return null;
        },
      },
    });
    expect(result.unparseable).toBe("verdicts");
    expect(result.truncated).toBe(true);
  });

  it("a plain unparseable reply is not reported as truncated", async () => {
    const result = await scoreFaithfulness("Formulas", "text", ctx, {
      extractor: { decompose: async () => ({ claims: [], unparseable: true as const }) },
      judge: { judge: async () => null },
    });
    expect(result.unparseable).toBe("claims");
    expect(result.truncated).toBeUndefined();
  });
});

describe("groundingUnparseableWarning — truncation wording (#152)", () => {
  it("claims cut off: names the output cap and the claim cap knob, not json_object", () => {
    const w = groundingUnparseableWarning("Formulas", "claims", "truncated");
    expect(w.message).toContain("output cap");
    expect(w.message).toContain("DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS");
    expect(w.message).not.toContain("json_object");
    expect(w.kind).toBe("section-ungrounded");
  });

  it("verdicts cut off: names the judge's cap knob, not json_object", () => {
    const w = groundingUnparseableWarning("Formulas", "verdicts", "truncated");
    expect(w.message).toContain("output cap");
    expect(w.message).toContain("DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS");
    expect(w.message).not.toContain("json_object");
  });

  it("an unparseable (not truncated) reply only suggests json_object when structured output is off", () => {
    const w = groundingUnparseableWarning("Formulas", "claims");
    expect(w.message).toContain("could not be parsed");
    expect(w.message).toMatch(/If DOCS_GEN_LOCAL_STRUCTURED_OUTPUT is off/);
  });
});
