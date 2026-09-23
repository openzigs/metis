/**
 * #117 — local structured output for runtimes that accept `json_schema` with
 * HTTP 200 and then ignore it.
 *
 * Measured against Ollama 0.34.2: `laguna-s-2.1` answered a `json_schema`
 * request with a markdown bullet list and the same request in `json_object`
 * mode with valid JSON. The claim extractor then logged "Failed to parse claim
 * decomposition as JSON, returning empty" and the section got zero claims and
 * no faithfulness check, silently.
 *
 * The provider double below reproduces that runtime exactly: prose for
 * `json_schema` (or no `response_format`), JSON for `json_object`.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatMessage, ChatOptions } from "../../ai/types.js";
import { ClaimExtractor } from "./claim-extractor.js";
import { FaithfulnessJudge } from "./faithfulness-judge.js";
import { buildGroundingContext } from "./grounding-context.js";
import {
  CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
  FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
  JSON_OBJECT_RESPONSE_FORMAT,
  parseStructuredOutputMode,
} from "./structured-output-schemas.js";

const PROSE = "- Invoices over 1000 need approval.\n- Approvals are logged.";

interface Call {
  messages: ChatMessage[];
  opts: ChatOptions;
}

/** A runtime that ignores `json_schema` (prose) but honours `json_object` (JSON). */
function acceptAndIgnoreJsonSchema(json: unknown, opts: { honourJsonObject?: boolean } = {}) {
  const calls: Call[] = [];
  const honour = opts.honourJsonObject ?? true;
  const provider = {
    key: "local-gemma",
    model: "laguna-s-2.1",
    offline: false,
    chat: vi.fn(async (messages: ChatMessage[], o: ChatOptions = {}) => {
      calls.push({ messages, opts: o });
      const content =
        honour && o.responseFormat?.type === "json_object" ? JSON.stringify(json) : PROSE;
      return { content, usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
    }),
  } as unknown as AIProvider;
  return { provider, calls };
}

const ctx = buildGroundingContext({
  ragChunks: [
    { documentId: "doc1", chunkId: "c1", filename: "Billing.java", text: "Invoices > 1000." },
  ],
});

const CLAIMS = { claims: [{ claim: "Invoices over 1000 need approval.", sourceIds: [] }] };
const VERDICTS = {
  verdicts: [{ claim: "Invoices over 1000 need approval.", supported: true, sourceIds: [] }],
};
const systemOf = (c: Call) => String(c.messages[0].content);

describe("parseStructuredOutputMode (#117)", () => {
  it("accepts the three modes and keeps 1/0 compatible", () => {
    expect(parseStructuredOutputMode("json_schema")).toBe("json_schema");
    expect(parseStructuredOutputMode("json_object")).toBe("json_object");
    expect(parseStructuredOutputMode("off")).toBe("off");
    expect(parseStructuredOutputMode("1")).toBe("json_schema");
    expect(parseStructuredOutputMode("true")).toBe("json_schema");
    expect(parseStructuredOutputMode("0")).toBe("off");
    expect(parseStructuredOutputMode(" JSON_OBJECT ")).toBe("json_object");
    expect(parseStructuredOutputMode(undefined)).toBe("off");
    expect(parseStructuredOutputMode("")).toBe("off");
    expect(parseStructuredOutputMode("bogus")).toBe("off");
  });
});

describe("ClaimExtractor — json_object mode and json_schema fallback (#117)", () => {
  it("json_object mode sends response_format json_object and states the shape in the prompt", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(CLAIMS);
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: JSON_OBJECT_RESPONSE_FORMAT,
    });
    const out = await extractor.decompose("Invoices over 1000 need approval.", ctx);
    expect(out.claims).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.responseFormat).toEqual({ type: "json_object" });
    expect(systemOf(calls[0])).toContain(
      JSON.stringify(CLAIM_DECOMPOSITION_RESPONSE_FORMAT.json_schema.schema),
    );
  });

  it("a json_schema reply that does not parse is retried once in json_object mode", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(CLAIMS);
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
    });
    const out = await extractor.decompose("Invoices over 1000 need approval.", ctx);
    expect(out.claims.map((c) => c.claim)).toEqual(["Invoices over 1000 need approval."]);
    expect(out.unparseable).toBeUndefined();
    expect(calls).toHaveLength(2);
    expect(calls[0].opts.responseFormat).toEqual(CLAIM_DECOMPOSITION_RESPONSE_FORMAT);
    expect(calls[1].opts.responseFormat).toEqual({ type: "json_object" });
    expect(systemOf(calls[1])).toContain('"claims"');
    expect(systemOf(calls[1])).toContain("JSON Schema");
    // The json_schema request itself carries no duplicate shape suffix.
    expect(systemOf(calls[0])).not.toContain("JSON Schema");
  });

  it("does not retry when the json_schema reply parses", async () => {
    const provider = {
      key: "local-gemma",
      model: "gemma3:12b",
      offline: false,
      chat: vi.fn(async () => ({ content: JSON.stringify(CLAIMS) })),
    } as unknown as AIProvider;
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
    });
    await extractor.decompose("Invoices over 1000 need approval.", ctx);
    expect(provider.chat).toHaveBeenCalledTimes(1);
  });

  it("reports an unparseable response instead of silently returning no claims", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(CLAIMS, { honourJsonObject: false });
    const extractor = new ClaimExtractor({
      provider,
      responseFormat: CLAIM_DECOMPOSITION_RESPONSE_FORMAT,
    });
    const out = await extractor.decompose("Invoices over 1000 need approval.", ctx);
    expect(out).toEqual({ claims: [], unparseable: true });
    expect(calls).toHaveLength(2);
  });

  it("with structured output off, an unparseable reply is reported and not retried", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(CLAIMS);
    const extractor = new ClaimExtractor({ provider });
    const out = await extractor.decompose("Invoices over 1000 need approval.", ctx);
    expect(out).toEqual({ claims: [], unparseable: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.responseFormat).toBeUndefined();
  });

  it("a genuinely empty claim list is not reported as unparseable", async () => {
    const provider = {
      key: "local-gemma",
      model: "m",
      offline: false,
      chat: vi.fn(async () => ({ content: JSON.stringify({ claims: [] }) })),
    } as unknown as AIProvider;
    const out = await new ClaimExtractor({ provider }).decompose("Heading only.", ctx);
    expect(out).toEqual({ claims: [] });
  });
});

describe("FaithfulnessJudge — json_object mode and json_schema fallback (#117)", () => {
  const claims = ["Invoices over 1000 need approval."];

  it("json_object mode sends response_format json_object and states the shape", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(VERDICTS);
    const judge = new FaithfulnessJudge({ provider, responseFormat: JSON_OBJECT_RESPONSE_FORMAT });
    const verdicts = await judge.judge(claims, ctx);
    expect(verdicts).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.responseFormat).toEqual({ type: "json_object" });
    expect(systemOf(calls[0])).toContain(
      JSON.stringify(FAITHFULNESS_VERDICTS_RESPONSE_FORMAT.json_schema.schema),
    );
  });

  it("the retry of an unparseable json_schema batch switches to json_object mode", async () => {
    const { provider, calls } = acceptAndIgnoreJsonSchema(VERDICTS);
    const judge = new FaithfulnessJudge({
      provider,
      responseFormat: FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
    });
    const verdicts = await judge.judge(claims, ctx);
    expect(verdicts).toEqual([{ claim: claims[0], supported: true, sourceIds: [] }]);
    expect(calls).toHaveLength(2);
    expect(calls[0].opts.responseFormat).toEqual(FAITHFULNESS_VERDICTS_RESPONSE_FORMAT);
    expect(calls[1].opts.responseFormat).toEqual({ type: "json_object" });
    expect(systemOf(calls[1])).toContain("JSON Schema");
  });

  it("counts batches that stayed unparseable in the diagnostics it is given", async () => {
    const { provider } = acceptAndIgnoreJsonSchema(VERDICTS, { honourJsonObject: false });
    const judge = new FaithfulnessJudge({
      provider,
      responseFormat: FAITHFULNESS_VERDICTS_RESPONSE_FORMAT,
    });
    const diagnostics = { batches: 0, unparseableBatches: 0 };
    expect(await judge.judge(claims, ctx, undefined, diagnostics)).toBeNull();
    expect(diagnostics).toEqual({ batches: 1, unparseableBatches: 1 });
  });

  it("a batch that parses but matches too few claims is not counted as unparseable", async () => {
    const provider = {
      key: "local-gemma",
      model: "m",
      offline: false,
      chat: vi.fn(async () => ({
        content: JSON.stringify({
          verdicts: [{ claim: "something else", supported: true, sourceIds: [] }],
        }),
      })),
    } as unknown as AIProvider;
    const diagnostics = { batches: 0, unparseableBatches: 0 };
    expect(
      await new FaithfulnessJudge({ provider }).judge(claims, ctx, undefined, diagnostics),
    ).toBeNull();
    expect(diagnostics).toEqual({ batches: 1, unparseableBatches: 0 });
  });
});
