/**
 * Issue #2234 — the pure half of contextual chunks: what the prefix says, when it
 * is withheld, how a stored row's indexed text is rebuilt, and how the `model`
 * generator spends its calls. The ingest wiring is proven against a real database
 * in `tests/rag-contextual-chunks-2234.sqlite.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import {
  buildContextPrefix,
  clip,
  contextPrefixesFor,
  contextPrefixOf,
  contextSystemPrompt,
  documentSummaryLine,
  fittingPrefix,
  headingPathLine,
  indexedTextOf,
  isContextualDocument,
  MODEL_CONTEXT_FAILURE_LIMIT,
  modelChunkContextGenerator,
  prefixedText,
  resolveContextualChunksMode,
} from "./contextual-chunks.js";
import { EMBED_INPUT_MAX_BYTES } from "./embed-input-budget.js";

describe("resolveContextualChunksMode", () => {
  it("is off when unset or blank", () => {
    expect(resolveContextualChunksMode(undefined)).toBe("off");
    expect(resolveContextualChunksMode("  ")).toBe("off");
  });
  it("reads the three modes, case-insensitively", () => {
    expect(resolveContextualChunksMode("headings")).toBe("headings");
    expect(resolveContextualChunksMode(" MODEL ")).toBe("model");
    expect(resolveContextualChunksMode("off")).toBe("off");
  });
  it("turns an unknown value off rather than guessing", () => {
    expect(resolveContextualChunksMode("on")).toBe("off");
  });
});

describe("documentSummaryLine", () => {
  it("is the H1 title and the lead sentence of the first prose paragraph", () => {
    const text = [
      "---",
      "title: ignored front matter",
      "---",
      "# Leave Policy",
      "",
      "| col | col |",
      "|---|---|",
      "",
      "```",
      "code is not a lead",
      "```",
      "Employees request leave through the",
      "HR portal. Managers approve it.",
    ].join("\n");
    expect(documentSummaryLine(text, "x.md")).toBe(
      "Leave Policy: Employees request leave through the HR portal.",
    );
  });
  it("falls back to the filename without its extension when there is no H1", () => {
    expect(documentSummaryLine("## Only a section\n\nSome prose here.", "dir/My FRD.docx")).toBe(
      "My FRD: Some prose here.",
    );
  });
  it("is the title alone when the document has no prose", () => {
    expect(documentSummaryLine("# Title\n\n| a |\n", "t.md")).toBe("Title");
  });
  it("strips link and emphasis markup and list markers from the lead", () => {
    expect(documentSummaryLine("# T\n\n- See **the** [guide](http://x) now.", "t.md")).toBe(
      "T: See the guide now.",
    );
  });
  it("is clipped to its maximum", () => {
    const line = documentSummaryLine(`# T\n\n${"word ".repeat(200)}`, "t.md");
    expect(line.length).toBeLessThanOrEqual(200);
    expect(line.endsWith("…")).toBe(true);
  });
});

describe("headingPathLine / buildContextPrefix", () => {
  it("joins the heading trail", () => {
    expect(headingPathLine(["A", "**B**", ""])).toBe("A > B");
    expect(headingPathLine([])).toBe("");
  });
  it("omits empty parts and orders Document, Section, Context", () => {
    expect(buildContextPrefix({ summary: "S", headings: ["A", "B"], chunkContext: " c  d " })).toBe(
      "Document: S\nSection: A > B\nContext: c d",
    );
    expect(buildContextPrefix({ summary: "S", headings: [] })).toBe("Document: S");
    expect(buildContextPrefix({ summary: "", headings: [], chunkContext: null })).toBe("");
  });
});

describe("clip", () => {
  it("cuts at a word boundary with an ellipsis", () => {
    expect(clip("alpha beta gamma", 12)).toBe("alpha beta…");
    expect(clip("  short  ", 12)).toBe("short");
  });
});

describe("prefixedText / fittingPrefix", () => {
  it("puts the prefix and a blank line before the chunk", () => {
    expect(prefixedText("body", "P")).toBe("P\n\nbody");
    expect(prefixedText("body", "")).toBe("body");
    expect(prefixedText("body", null)).toBe("body");
  });
  it("keeps the prefix for an ASCII chunk", () => {
    expect(fittingPrefix("a".repeat(2000), "Document: T")).toBe("Document: T");
  });
  it("withholds the prefix when it would push a non-ASCII chunk past the embedder's input", () => {
    // 680 three-byte characters = 2,040 bytes: fits alone, not with a prefix.
    const cjk = "漢".repeat(680);
    expect(Buffer.byteLength(cjk)).toBeLessThanOrEqual(EMBED_INPUT_MAX_BYTES);
    expect(fittingPrefix(cjk, "Document: 規程")).toBe("");
    expect(fittingPrefix("漢".repeat(10), "Document: 規程")).toBe("Document: 規程");
  });
  it("keeps the prefix on a chunk already over budget — truncation is not made worse", () => {
    expect(fittingPrefix("漢".repeat(900), "P")).toBe("P");
  });
  it("is empty for an empty prefix", () => {
    expect(fittingPrefix("x", "")).toBe("");
  });
});

describe("contextPrefixOf / indexedTextOf", () => {
  it("reads the persisted prefix from JSON or an object", () => {
    expect(contextPrefixOf('{"contextPrefix":"P","md5":"x"}')).toBe("P");
    expect(contextPrefixOf({ contextPrefix: "Q" })).toBe("Q");
    expect(indexedTextOf("body", '{"contextPrefix":"P"}')).toBe("P\n\nbody");
  });
  it("is the bare text for a row with no prefix, bad JSON or a non-string value", () => {
    for (const meta of [null, undefined, "", "{", "[]", "null", '{"contextPrefix":7}', "{}"]) {
      expect(indexedTextOf("body", meta)).toBe("body");
    }
  });
});

describe("isContextualDocument", () => {
  it("excludes repository source files only", () => {
    expect(isContextualDocument("frd.docx")).toBe(true);
    expect(isContextualDocument("connector:repo:r1:src/a/b.go")).toBe(false);
  });
});

describe("contextPrefixesFor", () => {
  const chunks = [
    { text: "first", headings: ["T"] },
    { text: "second", headings: ["T", "S"] },
  ];
  const base = { projectId: "p", filename: "d.md", documentText: "# T\n\nLead here.", chunks };

  it("is all empty when off, without calling the generator", async () => {
    const generator = vi.fn();
    expect(await contextPrefixesFor({ ...base, mode: "off", generator })).toEqual(["", ""]);
    expect(generator).not.toHaveBeenCalled();
  });
  it("is all empty for a repository file", async () => {
    expect(
      await contextPrefixesFor({ ...base, mode: "headings", filename: "connector:repo:r:src/x" }),
    ).toEqual(["", ""]);
  });
  it("headings: summary and heading path, no generator call", async () => {
    const generator = vi.fn();
    expect(await contextPrefixesFor({ ...base, mode: "headings", generator })).toEqual([
      "Document: T: Lead here.\nSection: T",
      "Document: T: Lead here.\nSection: T > S",
    ]);
    expect(generator).not.toHaveBeenCalled();
  });
  it("model: appends each chunk's context; a null keeps the deterministic prefix", async () => {
    const generator = vi.fn(async () => [null, "About S."]);
    expect(await contextPrefixesFor({ ...base, mode: "model", generator })).toEqual([
      "Document: T: Lead here.\nSection: T",
      "Document: T: Lead here.\nSection: T > S\nContext: About S.",
    ]);
    expect(generator).toHaveBeenCalledWith({
      projectId: "p",
      document: base.documentText,
      title: "T: Lead here.",
      chunks: ["first", "second"],
    });
  });
  it("model: a generator that throws leaves every chunk its deterministic prefix", async () => {
    const generator = vi.fn(async () => {
      throw new Error("boom");
    });
    expect(await contextPrefixesFor({ ...base, mode: "model", generator })).toEqual([
      "Document: T: Lead here.\nSection: T",
      "Document: T: Lead here.\nSection: T > S",
    ]);
  });
});

function response(content: string, extra: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content,
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    },
    model: "m",
    provider: "anthropic",
    ...extra,
  } as ChatResponse;
}

/** A provider whose `chat` is scripted per call and records call order and overlap. */
function scriptedProvider(reply: (chunk: string, call: number) => Promise<ChatResponse>) {
  const calls: { messages: ChatMessage[]; opts: ChatOptions | undefined }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const inFlightAtStart: number[] = [];
  const provider = {
    key: "anthropic",
    model: "m",
    chat: async (messages: ChatMessage[], opts?: ChatOptions) => {
      calls.push({ messages, opts });
      inFlightAtStart.push(inFlight);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        const user = String(messages[1].content);
        return await reply(user, calls.length - 1);
      } finally {
        inFlight -= 1;
      }
    },
  } as unknown as AIProvider;
  return { provider, calls, inFlightAtStart, maxInFlight: () => maxInFlight };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

describe("modelChunkContextGenerator", () => {
  const doc = "# Policy\n\nThe whole document.";
  const input = (chunks: string[]) => ({ projectId: "p1", document: doc, title: "Policy", chunks });

  it("caches the document as the system prefix and sends each chunk as the user turn", async () => {
    const s = scriptedProvider(async (user) => response(`ctx for ${user.includes("c1") ? 1 : 0}`));
    const gen = modelChunkContextGenerator({ provider: () => s.provider });
    expect(await gen(input(["c0", "c1"]))).toEqual(["ctx for 0", "ctx for 1"]);
    expect(s.calls[0].messages[0]).toEqual({
      role: "system",
      content: contextSystemPrompt(doc, "Policy"),
    });
    expect(String(s.calls[0].messages[0].content)).toContain(doc);
    expect(s.calls[0].messages[1].content).toContain("<excerpt>\nc0\n</excerpt>");
    expect(s.calls[0].opts?.promptCaching).toEqual({ system: true });
    // Both calls share one byte-identical system prompt — the cache key.
    expect(s.calls[1].messages[0]).toEqual(s.calls[0].messages[0]);
  });

  it("runs the first chunk alone, then the rest concurrently up to the limit", async () => {
    const s = scriptedProvider(async () => {
      await tick();
      return response("ok");
    });
    const gen = modelChunkContextGenerator({ provider: () => s.provider, concurrency: 3 });
    await gen(input(["a", "b", "c", "d", "e", "f"]));
    expect(s.calls).toHaveLength(6);
    expect(s.inFlightAtStart[0]).toBe(0);
    expect(s.inFlightAtStart[1]).toBe(0); // the cache-writing call finished first
    expect(s.maxInFlight()).toBe(3);
  });

  it("gives a failed chunk null and reports usage over the successful calls", async () => {
    const onUsage = vi.fn();
    const s = scriptedProvider(async (_user, call) => {
      if (call === 1) throw new Error("rate limited");
      return response("fine", {
        usage: {
          promptTokens: 1,
          completionTokens: 2,
          totalTokens: 3,
          cacheReadTokens: 40,
          cacheWriteTokens: 60,
        },
      });
    });
    const gen = modelChunkContextGenerator({
      provider: () => s.provider,
      concurrency: 1,
      onUsage,
    });
    expect(await gen(input(["a", "b", "c"]))).toEqual(["fine", null, "fine"]);
    expect(onUsage).toHaveBeenCalledWith({
      calls: 3,
      failures: 1,
      promptTokens: 2,
      completionTokens: 4,
      cacheReadTokens: 80,
      cacheWriteTokens: 120,
    });
  });

  it("stops calling after repeated failures with no success", async () => {
    const s = scriptedProvider(async () => {
      throw new Error("401");
    });
    const gen = modelChunkContextGenerator({ provider: () => s.provider, concurrency: 1 });
    const out = await gen(input(Array.from({ length: 10 }, (_, i) => `c${i}`)));
    expect(out).toEqual(Array.from({ length: 10 }, () => null));
    expect(s.calls).toHaveLength(MODEL_CONTEXT_FAILURE_LIMIT);
  });

  it("treats an offline stub reply and an empty reply as no context", async () => {
    const s = scriptedProvider(async (_u, call) =>
      call === 0 ? response("stub", { offline: true }) : response("   "),
    );
    const gen = modelChunkContextGenerator({ provider: () => s.provider, concurrency: 1 });
    expect(await gen(input(["a", "b"]))).toEqual([null, null]);
  });

  it("does not call the model for a document over the size cap, nor for no chunks", async () => {
    const s = scriptedProvider(async () => response("x"));
    const gen = modelChunkContextGenerator({ provider: () => s.provider, maxDocumentChars: 5 });
    expect(await gen(input(["a"]))).toEqual([null]);
    expect(await gen(input([]))).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });

  it("keeps deterministic prefixes when the provider cannot be built, and passes the project", async () => {
    const factory = vi.fn(() => {
      throw new Error("no key");
    });
    const gen = modelChunkContextGenerator({ provider: factory });
    expect(await gen(input(["a"]))).toEqual([null]);
    expect(factory).toHaveBeenCalledWith("p1");
  });

  it("clips a long reply", async () => {
    const s = scriptedProvider(async () => response("word ".repeat(200)));
    const gen = modelChunkContextGenerator({ provider: () => s.provider });
    const [ctx] = await gen(input(["a"]));
    expect(ctx!.length).toBeLessThanOrEqual(300);
  });
});
