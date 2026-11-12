import { describe, expect, it } from "vitest";
import {
  applyArmEnv,
  armArgument,
  ARM_FLAGS,
  assertComparable,
  budgetStop,
  buildJudgedSpans,
  chatSessionScope,
  embedRuntimeFor,
  parseArm,
  sliceLines,
  unknownSources,
} from "./run.js";

describe("arms", () => {
  it("parses the named arms only", () => {
    for (const arm of ["default", "off", "on", "no-tools", "no-fused", "no-rerank", "tools-only"]) {
      expect(parseArm(arm)).toBe(arm);
    }
    expect(() => parseArm("both")).toThrow(
      /default, off, on, no-tools, no-fused, no-rerank, tools-only/,
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
      [0, [1]],
      [2, []],
      [3, []],
      [4, [2]],
    ]);
  });

  it("reads a shared path in every product it names, once per distinct text", async () => {
    const files: Record<string, string> = {
      "srv:README.md": "server readme\nline two",
      "cli:README.md": "client readme",
      "srv:FRD.md": "same\nfrd",
      "cli:FRD.md": "same\nfrd",
    };
    const read = async (product: string, file: string): Promise<string | null> =>
      files[`${product}:${file}`] ?? null;
    const { spans, index } = await buildJudgedSpans(
      [
        // Different text in each product: each is shown, under its own product.
        { path: "README.md", products: ["cli", "srv"], lines: [1, 1] },
        // The same uploaded document in both: shown once, labelled with both.
        { path: "FRD.md", products: ["cli", "srv"], lines: [1, 2] },
        // Lines only one product's file has: only that one is shown.
        { path: "README.md", products: ["cli", "srv"], lines: [2, 2] },
      ],
      read,
    );
    expect(spans).toEqual([
      { n: 1, label: "cli:README.md:1-1", text: "client readme" },
      { n: 2, label: "srv:README.md:1-1", text: "server readme" },
      { n: 3, label: "cli,srv:FRD.md:1-2", text: "same\nfrd" },
      { n: 4, label: "srv:README.md:2-2", text: "line two" },
    ]);
    expect([...index]).toEqual([
      [0, [1, 2]],
      [1, [3]],
      [2, [4]],
    ]);
  });
});

describe("budgetStop", () => {
  const base = { budgetUsd: 1, spentUsd: 0, unpricedCalls: 0, questionCosts: [] as number[] };

  it("lets the first question run, and any while the costliest so far still fits", () => {
    expect(budgetStop(base)).toBeNull();
    expect(budgetStop({ ...base, spentUsd: 0.6, questionCosts: [0.2, 0.4] })).toBeNull();
  });

  it("stops at the cap, and before a question the costliest so far would carry over it", () => {
    expect(budgetStop({ ...base, spentUsd: 1 })).toBe("the $1 cap was reached");
    expect(budgetStop({ ...base, spentUsd: 0.7, questionCosts: [0.1, 0.35] })).toBe(
      "the next question would pass the $1 cap at the costliest one so far ($0.3500)",
    );
  });

  it("stops on an unpriced call, whatever was spent", () => {
    expect(budgetStop({ ...base, unpricedCalls: 1 })).toMatch(/unpriced call/);
  });
});

describe("assertComparable", () => {
  const current = {
    kind: "ba-qa",
    arm: "on",
    model: "m",
    judgeModel: "j",
    fixture: { id: "f", version: 1 },
  };

  it("accepts another arm of the same fixture, model and judge", () => {
    expect(() =>
      assertComparable({ ...current, arm: "off" }, current, ["on"], "x.json"),
    ).not.toThrow();
  });

  it.each<[string, Record<string, unknown>, RegExp]>([
    ["another kind", { kind: "chat-cache" }, /not comparable/],
    ["another fixture", { fixture: { id: "g", version: 1 } }, /not comparable/],
    ["another model", { model: "m2" }, /model m2, not m/],
    ["another judge", { judgeModel: "j2" }, /judged by j2, not j/],
    ["no judge recorded", { judgeModel: undefined }, /judged by \(unknown\), not j/],
    ["another fixture version", { fixture: { id: "f", version: 2 } }, /version 2, not 1/],
    ["an arm already in the report", { arm: "on" }, /arm on is already in the report/],
  ])("refuses %s", (_label, edit, message) => {
    expect(() =>
      assertComparable({ ...current, arm: "off", ...edit }, current, ["on"], "x.json"),
    ).toThrow(message);
  });
});

describe("unknownSources", () => {
  const products = new Map([
    [
      "srv",
      {
        name: "srv",
        files: ["a.go", "miniflux.1"],
        documents: new Map([
          ["miniflux.1.txt", "miniflux.1"],
          ["FRD.md", "FRD.md"],
        ]),
      },
    ],
  ]);
  const q = (path: string, kind?: "doc") => ({
    id: "S1",
    sources: [{ product: "srv", path, ...(kind ? { kind } : {}) }],
  });

  it("finds every source among the product's files and documents", () => {
    expect(
      unknownSources([q("a.go"), q("miniflux.1", "doc"), q("FRD.md", "doc")], products),
    ).toEqual([]);
  });

  it("names a source no file or document answers to, such as a doc by its upload name", () => {
    expect(
      unknownSources(
        [q("miniflux.1.txt", "doc"), q("frd.md", "doc"), q("b.go"), { id: "A1" }],
        products,
      ),
    ).toEqual(["S1: srv:miniflux.1.txt", "S1: srv:frd.md", "S1: srv:b.go"]);
  });
});
