import { describe, expect, it } from "vitest";
import {
  applyArmEnv,
  armArgument,
  ARM_FLAGS,
  buildJudgedSpans,
  chatSessionScope,
  embedRuntimeFor,
  parseArm,
  sliceLines,
} from "./run.js";

describe("arms", () => {
  it("parses the named arms only", () => {
    for (const arm of [
      "default",
      "off",
      "on",
      "no-tools",
      "no-fused",
      "no-rerank",
      "tools-only",
      "tools-primitives",
    ]) {
      expect(parseArm(arm)).toBe(arm);
    }
    expect(() => parseArm("both")).toThrow(
      /default, off, on, no-tools, no-fused, no-rerank, tools-only, tools-primitives/,
    );
    // An inherited Object key is not an arm.
    expect(() => parseArm("toString")).toThrow(/not toString/);
  });

  it("reads --arm before parseArgs runs, and picks the embedder runtime from it", () => {
    expect(armArgument(["--budget", "1", "--arm", "on"])).toBe("on");
    expect(armArgument(["--arm=off"])).toBe("off");
    expect(armArgument(["--arm"])).toBeNull();
    expect(armArgument(["--budget", "1"])).toBeNull();
    // #222: inline exactly when the arm turns the cross-encoder on.
    expect(embedRuntimeFor("on")).toBe("inline");
    expect(embedRuntimeFor("no-tools")).toBe("inline");
    expect(embedRuntimeFor("no-fused")).toBe("inline");
    expect(embedRuntimeFor("no-rerank")).toBe("worker");
    expect(embedRuntimeFor("tools-only")).toBe("worker");
    expect(embedRuntimeFor("tools-primitives")).toBe("worker");
    expect(embedRuntimeFor("off")).toBe("worker");
    expect(embedRuntimeFor("default")).toBe("worker");
    expect(embedRuntimeFor("nonsense")).toBe("worker");
    expect(embedRuntimeFor(null)).toBe("worker");
  });

  it("off turns every flag off whatever a shell or .env set, on sets all three", () => {
    const env: NodeJS.ProcessEnv = {
      CHAT_CODE_SEARCH_TOOLS: "true",
      CHAT_FUSED_CODE_RETRIEVAL: "true",
      RAG_RERANK: "1",
      OTHER: "kept",
    };
    const off = applyArmEnv(env, "off");
    for (const k of ARM_FLAGS) {
      // Explicitly off, not unset: unset now reads the server's default.
      expect(env[k]).toBe("0");
      expect(off[k]).toBe("0");
    }
    expect(env.OTHER).toBe("kept");
    const on = applyArmEnv(env, "on");
    for (const k of ARM_FLAGS) {
      expect(env[k]).toBe("1");
      expect(on[k]).toBe("1");
    }
  });

  it("default unsets every flag, and each no-* arm turns exactly its one flag off", () => {
    const env: NodeJS.ProcessEnv = { CHAT_CODE_SEARCH_TOOLS: "0", RAG_RERANK: "1" };
    const dflt = applyArmEnv(env, "default");
    for (const k of ARM_FLAGS) {
      expect(env[k]).toBeUndefined();
      expect(dflt[k]).toBe("(unset: default)");
    }
    const dropped = {
      "no-tools": "CHAT_CODE_SEARCH_TOOLS",
      "no-fused": "CHAT_FUSED_CODE_RETRIEVAL",
      "no-rerank": "RAG_RERANK",
    } as const;
    for (const [arm, flag] of Object.entries(dropped)) {
      applyArmEnv(env, arm as keyof typeof dropped);
      for (const k of ARM_FLAGS) expect(env[k]).toBe(k === flag ? "0" : "1");
    }
    applyArmEnv(env, "tools-only");
    for (const k of ARM_FLAGS) expect(env[k]).toBe(k === "CHAT_CODE_SEARCH_TOOLS" ? "1" : "0");
    // #2327 — the primitives' arm is tools-only plus exactly the primitives.
    applyArmEnv(env, "tools-primitives");
    for (const k of ARM_FLAGS) {
      expect(env[k]).toBe(
        k === "CHAT_CODE_SEARCH_TOOLS" || k === "CHAT_CODE_SEARCH_PRIMITIVES" ? "1" : "0",
      );
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
