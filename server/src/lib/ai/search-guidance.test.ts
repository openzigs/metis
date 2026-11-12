/**
 * #2324 — the search guidance: one prompt block, four tool usages, two fixed
 * per-result instructions. The block must not restate #2241's answering policy.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ANSWER_POLICY_INSTRUCTION,
  CITATION_INSTRUCTION,
  assembleChatSystem,
} from "./chat-system-prompt.js";
import {
  EMPTY_RESULT_INSTRUCTIONS,
  GROUNDING_TOOL_NAMES,
  SEARCH_GUIDANCE_INSTRUCTION,
  SEARCH_GUIDANCE_KEY,
  SEARCH_TOOL_USAGE,
  SOURCE_RESULT_INSTRUCTIONS,
  offersGroundingTool,
  resultInstructions,
  searchGuidanceEnabled,
  withSearchUsage,
} from "./search-guidance.js";
import { TOOL_RESULT_FENCE } from "./tool-runtime/fence.js";
import { estimateTokens } from "../analysis/context-window-manager.js";

/** Sentences, compared without case, whitespace or the list markup. */
function sentences(text: string): string[] {
  return text
    .replace(/^#+ .*$/gm, "")
    .replace(/^\s*- /gm, "")
    .split(/(?<=[.!?:])\s+/)
    .map((s) => s.replace(/\s+/g, " ").trim().toLowerCase())
    .filter((s) => s.length > 0);
}

describe("SEARCH_GUIDANCE_INSTRUCTION (#2324)", () => {
  it("says how to search: identifiers, several wordings, the fallback order, verify, report", () => {
    const block = SEARCH_GUIDANCE_INSTRUCTION.replace(/\s+/g, " ");
    expect(block).toMatch(/function, class, table, route or config key/);
    expect(block).toMatch(/two or three differently worded searches/);
    expect(block).toMatch(/before you conclude that something is not there/);
    // symbol → text → file listing → read, in that order.
    const order = ["symbol search", "text search", "a file's symbols", "read the code"].map((s) =>
      block.indexOf(s),
    );
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(block).toMatch(/calls another.*read the code that does it/);
    expect(block).toMatch(/find nothing, list the terms and tools you searched with/);
  });

  it("shares no sentence with the #2241 answering policy, and both render in one prompt", () => {
    const policy = new Set(sentences(ANSWER_POLICY_INSTRUCTION));
    const shared = sentences(SEARCH_GUIDANCE_INSTRUCTION).filter((s) => policy.has(s));
    expect(shared).toEqual([]);
    // Nor does it take over the policy's decisions: abstaining and asking.
    expect(SEARCH_GUIDANCE_INSTRUCTION).not.toMatch(/ambiguous|follow-up|don't support/i);

    const a = assembleChatSystem({
      citationInstruction: CITATION_INSTRUCTION,
      answerPolicy: ANSWER_POLICY_INSTRUCTION,
      searchGuidance: SEARCH_GUIDANCE_INSTRUCTION,
      chronicle: "## memory",
    });
    // Both stable, the guidance after the policy, and never in the volatile tail.
    expect(a.stable.map((m) => m.content)).toEqual([
      CITATION_INSTRUCTION,
      ANSWER_POLICY_INSTRUCTION,
      SEARCH_GUIDANCE_INSTRUCTION,
    ]);
    expect(a.volatile.map((m) => m.content)).toEqual(["## memory"]);
  });

  it("is absent when not given, so a turn without grounding tools keeps its lead", () => {
    const without = assembleChatSystem({ answerPolicy: ANSWER_POLICY_INSTRUCTION });
    const blank = assembleChatSystem({
      answerPolicy: ANSWER_POLICY_INSTRUCTION,
      searchGuidance: " ",
    });
    expect(without.stable.map((m) => m.content)).toEqual([ANSWER_POLICY_INSTRUCTION]);
    expect(blank.stable).toEqual(without.stable);
  });

  it("stays inside its token budget", () => {
    // The PR states the per-turn cost from these numbers.
    expect(estimateTokens(SEARCH_GUIDANCE_INSTRUCTION)).toBeLessThanOrEqual(300);
    expect(estimateTokens(SOURCE_RESULT_INSTRUCTIONS)).toBeLessThanOrEqual(60);
    expect(estimateTokens(EMPTY_RESULT_INSTRUCTIONS)).toBeLessThanOrEqual(60);
    for (const usage of Object.values(SEARCH_TOOL_USAGE)) {
      expect(estimateTokens(usage)).toBeLessThanOrEqual(90);
    }
  });
});

describe("SEARCH_TOOL_USAGE (#2324)", () => {
  it("covers exactly the four grounding tools", () => {
    expect(Object.keys(SEARCH_TOOL_USAGE).sort()).toEqual([...GROUNDING_TOOL_NAMES].sort());
  });

  it.each(Object.entries(SEARCH_TOOL_USAGE))(
    "%s says when to use it, what a good query is, and what to do on nothing found",
    (_name, usage) => {
      expect(usage).toMatch(/^When: /);
      expect(usage).toMatch(/good query|narrow range/i);
      expect(usage).toMatch(/Empty result:|No matches:|File not found:/);
    },
  );

  it("is appended to a grounding tool's description and leaves any other tool's alone", () => {
    expect(withSearchUsage("search_code_graph", "Search the graph.")).toBe(
      `Search the graph. ${SEARCH_TOOL_USAGE.search_code_graph}`,
    );
    expect(withSearchUsage("query_database", "Run a SELECT.")).toBe("Run a SELECT.");
  });
});

describe("resultInstructions (#2324)", () => {
  it("gives a result that found something the source instruction", () => {
    expect(resultInstructions("search_code_symbols", { resultCount: 3 })).toBe(
      SOURCE_RESULT_INSTRUCTIONS,
    );
    // A file read has no count: it returned what it was asked for.
    expect(resultInstructions("read_file_slice", {})).toBe(SOURCE_RESULT_INSTRUCTIONS);
  });

  it("gives an empty result a different instruction, one that asks for another search", () => {
    const empty = resultInstructions("search-knowledge", { resultCount: 0 });
    expect(empty).toBe(EMPTY_RESULT_INSTRUCTIONS);
    expect(empty).not.toBe(SOURCE_RESULT_INSTRUCTIONS);
    expect(empty).toMatch(/Search again with other wording/);
  });

  it("gives none to a failed call or to a tool that is not a grounding tool", () => {
    expect(resultInstructions("search_code_graph", { isError: true, resultCount: 0 })).toBe(
      undefined,
    );
    expect(resultInstructions("query_database", { resultCount: 2 })).toBe(undefined);
  });

  it("is fixed text that cannot be read as a data fence", () => {
    for (const s of [SOURCE_RESULT_INSTRUCTIONS, EMPTY_RESULT_INSTRUCTIONS]) {
      expect(s).not.toContain(TOOL_RESULT_FENCE);
      expect(s).toMatch(/^Instructions from METIS, not the tool: /);
    }
    expect(SOURCE_RESULT_INSTRUCTIONS).toMatch(
      /answer only from these results.*cite each claim.*say so/,
    );
  });
});

describe("offersGroundingTool / searchGuidanceEnabled (#2324)", () => {
  const saved = process.env[SEARCH_GUIDANCE_KEY];
  afterEach(() => {
    if (saved === undefined) delete process.env[SEARCH_GUIDANCE_KEY];
    else process.env[SEARCH_GUIDANCE_KEY] = saved;
  });

  it("finds a grounding tool among the offered names", () => {
    expect(offersGroundingTool(["load_skill", "search-knowledge"])).toBe(true);
    expect(offersGroundingTool(["load_skill", "query_database"])).toBe(false);
    expect(offersGroundingTool([])).toBe(false);
  });

  it("reads the key, on by default", () => {
    delete process.env[SEARCH_GUIDANCE_KEY];
    expect(searchGuidanceEnabled()).toBe(true);
    process.env[SEARCH_GUIDANCE_KEY] = "false";
    expect(searchGuidanceEnabled()).toBe(false);
  });
});
