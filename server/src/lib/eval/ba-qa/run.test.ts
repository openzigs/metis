import { describe, expect, it } from "vitest";
import type { BaQaQuestion } from "./fixture.js";
import {
  applyArmEnv,
  armArgument,
  armLabel,
  ARM_FLAGS,
  buildJudgedSpans,
  chatSessionScope,
  embedRuntimeFor,
  parseArm,
  parseRetrievalMode,
  retrievedExpectedFiles,
  selectQuestions,
  sliceLines,
} from "./run.js";

describe("arms", () => {
  it("parses off and on only", () => {
    expect(parseArm("off")).toBe("off");
    expect(parseArm("on")).toBe("on");
    expect(() => parseArm("both")).toThrow(/off or on/);
  });

  it("reads --arm before parseArgs runs, and picks the embedder runtime from it", () => {
    expect(armArgument(["--budget", "1", "--arm", "on"])).toBe("on");
    expect(armArgument(["--arm=off"])).toBe("off");
    expect(armArgument(["--arm"])).toBeNull();
    expect(armArgument(["--budget", "1"])).toBeNull();
    expect(embedRuntimeFor("on")).toBe("inline");
    expect(embedRuntimeFor("off")).toBe("worker");
    expect(embedRuntimeFor(null)).toBe("worker");
  });

  it("off unsets every flag a shell or .env set, on sets all three", () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_CODE_SEARCH_TOOLS: "true",
      CHAT_FUSED_CODE_RETRIEVAL: "true",
      RAG_RERANK: "1",
      OTHER: "kept",
    };
    const off = applyArmEnv(env, "off");
    for (const k of ARM_FLAGS) {
      expect(env[k]).toBeUndefined();
      expect(off[k]).toBe("(unset: off)");
    }
    expect(env.OTHER).toBe("kept");
    const on = applyArmEnv(env, "on");
    for (const k of ARM_FLAGS) {
      expect(env[k]).toBe("1");
      expect(on[k]).toBe("1");
    }
  });
});

describe("chatSessionScope", () => {
  it("binds one project, and degrades two to unscoped as chat does", () => {
    expect(chatSessionScope(["p1"])).toEqual({ projectId: "p1", degraded: null });
    expect(chatSessionScope(["p1", "p2"])).toEqual({
      projectId: null,
      degraded: "multi-project-unsupported",
    });
    expect(chatSessionScope([])).toEqual({ projectId: null, degraded: null });
  });
});

describe("spans", () => {
  const text = ["one", "two", "three", "four"].join("\n");

  it("slices 1-based inclusive lines, clamps the end and refuses a start past the file", () => {
    expect(sliceLines(text, [2, 3])).toBe("two\nthree");
    expect(sliceLines(text, [3, 99])).toBe("three\nfour");
    expect(sliceLines(text, [5, 6])).toBeNull();
  });

  it("numbers readable spans, marks unreadable ranges 0 and skips citations without lines", async () => {
    const read = async (product: string, file: string): Promise<string | null> =>
      product === "srv" && file === "a.go" ? text : null;
    const { spans, index } = await buildJudgedSpans(
      [
        { path: "a.go", products: ["srv"], lines: [1, 2] },
        { path: "a.go", products: ["srv"], lines: null },
        { path: "a.go", products: ["srv"], lines: [40, 41] },
        { path: "gone.go", products: ["srv"], lines: [1, 1] },
        { path: "a.go", products: ["srv"], lines: [4, 4] },
      ],
      read,
    );
    expect(spans).toEqual([
      { n: 1, label: "srv:a.go:1-2", text: "one\ntwo" },
      { n: 2, label: "srv:a.go:4-4", text: "four" },
    ]);
    expect([...index]).toEqual([
      [0, 1],
      [2, 0],
      [3, 0],
      [4, 2],
    ]);
  });
});

describe("multi-turn runs (#2269)", () => {
  const q = (id: string, before?: string[]): BaQaQuestion => ({
    id,
    category: "single-product",
    scope: ["srv"],
    text: "t",
    expect: "answer",
    ...(before ? { before, refersBack: true } : {}),
  });
  const all = [q("S1"), q("F1", ["first"]), q("S2"), q("F2", ["first"])];

  it("parses the retrieval mode, and labels the arm by it", () => {
    expect(parseRetrievalMode("conversation")).toBe("conversation");
    expect(parseRetrievalMode("last-message")).toBe("last-message");
    expect(() => parseRetrievalMode("history")).toThrow(/conversation or last-message/);
    expect(armLabel("off", "conversation")).toBe("off");
    expect(armLabel("on", "last-message")).toBe("on+last-message");
  });

  it("runs the one-turn set by default, the multi-turn set on request, then filters", () => {
    expect(selectQuestions(all, {}).map((x) => x.id)).toEqual(["S1", "S2"]);
    expect(selectQuestions(all, { multiTurn: true }).map((x) => x.id)).toEqual(["F1", "F2"]);
    // Named questions are taken from either set.
    expect(selectQuestions(all, { ids: ["S2", "F2"] }).map((x) => x.id)).toEqual(["S2", "F2"]);
    expect(selectQuestions(all, { multiTurn: true, limit: 1 }).map((x) => x.id)).toEqual(["F1"]);
  });

  it("finds the expected files among the retrieved excerpts, uploads by their source path", () => {
    const product = { name: "srv", documents: new Map([["srv.1.txt", "srv.1"]]) };
    expect(
      retrievedExpectedFiles(["srv:a.go", "srv:srv.1", "srv:b.go"], product, [
        "a.go",
        "srv.1.txt",
        "c.go",
        "a.go",
      ]),
    ).toEqual(["srv:a.go", "srv:srv.1"]);
    expect(retrievedExpectedFiles(["srv:a.go"], product, [])).toEqual([]);
    // Another product's file of the same path is not this product's.
    expect(retrievedExpectedFiles(["cli:a.go"], product, ["a.go"])).toEqual([]);
  });
});
