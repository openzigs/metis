/**
 * Epic #197 / Issue #199 + #206 — SAS parser (`parseSas`) unit coverage.
 *
 * Exercises `parseSas` directly with representative SAS fixtures (macros,
 * DATA steps, PROC SQL, non-SQL PROC, `%include`, nested macro calls, libname/
 * filename, both comment styles) and the `detectLanguage`/`parseSource`
 * routing additions, including the tree-sitter short-circuit regression guard.
 */
import { describe, it, expect, vi } from "vitest";

import { detectLanguage, parseSas, type ParsedEdge } from "../../../src/lib/code-graph/parsers.js";

const lineageOf = (edges: ParsedEdge[], dataset: string) =>
  edges.find(
    (e) =>
      e.kind === "references" &&
      (e.metadata as { dataset?: string } | undefined)?.dataset === dataset,
  );

describe("detectLanguage — SAS", () => {
  it("maps .sas to sas", () => {
    expect(detectLanguage("etl/load.sas")).toBe("sas");
    expect(detectLanguage("ETL/LOAD.SAS")).toBe("sas");
  });
});

describe("parseSas — module symbol & language", () => {
  it("emits exactly one module symbol with qualifiedName = filePath", () => {
    const result = parseSas("etl/empty.sas", "");
    const modules = result.symbols.filter((s) => s.kind === "module");
    expect(modules).toHaveLength(1);
    expect(modules[0].qualifiedName).toBe("etl/empty.sas");
    expect(result.language).toBe("sas");
  });
});

describe("parseSas — macros", () => {
  it("captures a %macro ... %mend as a function symbol", () => {
    const src = ["%macro greet(name);", "  %put Hello &name;", "%mend greet;"].join("\n");
    const result = parseSas("m/greet.sas", src);
    const macro = result.symbols.find((s) => s.kind === "function" && s.name === "greet");
    expect(macro).toBeDefined();
    expect(macro?.startLine).toBe(1);
    expect(macro?.endLine).toBe(3);
    expect(
      result.edges.find((e) => e.kind === "defines" && e.toQualifiedName.endsWith("::greet")),
    ).toBeDefined();
  });

  it("captures nested macro invocations inside a macro body as calls", () => {
    const src = ["%macro outer;", "  %inner(x=1);", "%mend;"].join("\n");
    const result = parseSas("m/outer.sas", src);
    const call = result.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "inner");
    expect(call).toBeDefined();
    expect(call?.fromQualifiedName).toBe("m/outer.sas::outer");
    // %macro / %mend / %put are keywords, never calls.
    expect(result.edges.some((e) => e.kind === "calls" && e.toQualifiedName === "outer")).toBe(
      false,
    );
  });

  it("captures a top-level macro invocation %foo; as a call from the module", () => {
    const result = parseSas("m/run.sas", "%runjob;");
    const call = result.edges.find((e) => e.kind === "calls" && e.toQualifiedName === "runjob");
    expect(call).toBeDefined();
    expect(call?.fromQualifiedName).toBe("m/run.sas");
  });
});

describe("parseSas — DATA steps", () => {
  it("produces a function symbol plus output/input lineage edges", () => {
    const src = "data work.out; set work.in; run;";
    const result = parseSas("d/step.sas", src);
    const fn = result.symbols.find((s) => s.kind === "function" && s.name === "work.out");
    expect(fn).toBeDefined();

    const out = lineageOf(result.edges, "work.out");
    expect(out?.metadata).toMatchObject({ lineage: "output", dataset: "work.out" });
    const inp = lineageOf(result.edges, "work.in");
    expect(inp?.metadata).toMatchObject({ lineage: "input", dataset: "work.in" });
  });

  it("handles multi-output DATA steps with set + merge inputs", () => {
    const src = [
      "data work.a work.b;",
      "  set work.in1;",
      "  merge work.in2 work.in3;",
      "run;",
    ].join("\n");
    const result = parseSas("d/multi.sas", src);

    const outputs = result.edges.filter(
      (e) => (e.metadata as { lineage?: string } | undefined)?.lineage === "output",
    );
    expect(outputs.map((e) => (e.metadata as { dataset: string }).dataset).sort()).toEqual([
      "work.a",
      "work.b",
    ]);

    const inputs = result.edges
      .filter((e) => (e.metadata as { lineage?: string } | undefined)?.lineage === "input")
      .map((e) => (e.metadata as { dataset: string }).dataset)
      .sort();
    expect(inputs).toEqual(["work.in1", "work.in2", "work.in3"]);

    // The symbol is named after the first output dataset.
    expect(result.symbols.some((s) => s.kind === "function" && s.name === "work.a")).toBe(true);
  });

  it("captures update/modify inputs and falls back to a 'data' name", () => {
    const src = ["data _null_;", "  update master;", "  modify trans;", "run;"].join("\n");
    const result = parseSas("d/upd.sas", src);
    const inputs = result.edges
      .filter((e) => (e.metadata as { lineage?: string } | undefined)?.lineage === "input")
      .map((e) => (e.metadata as { dataset: string }).dataset)
      .sort();
    expect(inputs).toEqual(["master", "trans"]);
  });
});

describe("parseSas — PROC steps", () => {
  it("captures PROC SQL create/from lineage", () => {
    const src = ["proc sql;", "  create table results as select * from source;", "quit;"].join(
      "\n",
    );
    const result = parseSas("p/sql.sas", src);
    expect(result.symbols.some((s) => s.kind === "function" && s.name === "proc sql")).toBe(true);

    const out = lineageOf(result.edges, "results");
    expect(out?.metadata).toMatchObject({ lineage: "output", dataset: "results" });
    const inp = lineageOf(result.edges, "source");
    expect(inp?.metadata).toMatchObject({ lineage: "input", dataset: "source" });
  });

  it("captures a non-SQL PROC with data= (input) and out= (output)", () => {
    const src = ["proc means data=work.in noprint;", "  output out=work.summary;", "run;"].join(
      "\n",
    );
    const result = parseSas("p/means.sas", src);
    expect(result.symbols.some((s) => s.kind === "function" && s.name === "proc means")).toBe(true);

    expect(lineageOf(result.edges, "work.in")?.metadata).toMatchObject({ lineage: "input" });
    expect(lineageOf(result.edges, "work.summary")?.metadata).toMatchObject({ lineage: "output" });
  });

  it("ends a PROC step at the next step when no run;/quit; is present", () => {
    const src = ["proc print data=a;", "data b; set c; run;"].join("\n");
    const result = parseSas("p/implicit.sas", src);
    expect(result.symbols.some((s) => s.name === "proc print")).toBe(true);
    expect(result.symbols.some((s) => s.name === "b")).toBe(true);
  });
});

describe("parseSas — step body ranges (#fix B: no body collapse)", () => {
  const fnByName = (
    result: ReturnType<typeof parseSas>,
    name: string,
  ): { startLine: number; endLine: number } | undefined => {
    const s = result.symbols.find((x) => x.kind === "function" && x.name === name);
    return s ? { startLine: s.startLine, endLine: s.endLine } : undefined;
  };

  it("(a) a multi-statement PROC SQL with NO quit, followed immediately by a DATA step, spans its real body", () => {
    // The PROC SQL has a `create table … select …` body and runs straight into
    // a DATA step with no `quit;`. Its endLine must cover the SELECT (line 3),
    // NOT collapse to the `proc sql;` opener line (line 1).
    const src = [
      "proc sql;", // 1
      "  create table x as", // 2
      "  select a, b from src;", // 3
      "data y;", // 4
      "  set x;", // 5
      "run;", // 6
    ].join("\n");
    const result = parseSas("p/nostop.sas", src);
    const procSql = fnByName(result, "proc sql");
    expect(procSql).toBeDefined();
    expect(procSql!.startLine).toBe(1);
    // Body must extend past the opener to include the SELECT.
    expect(procSql!.endLine).toBeGreaterThanOrEqual(3);
    expect(procSql!.endLine).toBeGreaterThan(procSql!.startLine);
    // The following DATA step is captured separately and starts at line 4.
    const dataY = fnByName(result, "y");
    expect(dataY?.startLine).toBe(4);
  });

  it("(a') a multi-statement DATA step with NO run, bounded by the next step, spans its body", () => {
    const src = [
      "data a;", // 1
      "  set raw;", // 2
      "  if amount > 0;", // 3
      "data b;", // 4
      "  set a;", // 5
      "run;", // 6
    ].join("\n");
    const result = parseSas("d/nostop.sas", src);
    const a = fnByName(result, "a");
    expect(a).toBeDefined();
    expect(a!.startLine).toBe(1);
    // endLine must reach the subsetting IF (line 3), not collapse to line 1.
    expect(a!.endLine).toBeGreaterThanOrEqual(3);
    expect(a!.endLine).toBeGreaterThan(a!.startLine);
  });

  it("(b) regression: an explicit `proc sort … ; by x; run;` still spans correctly", () => {
    const src = [
      "proc sort data=a;", // 1
      "  by x;", // 2
      "run;", // 3
    ].join("\n");
    const result = parseSas("p/sort.sas", src);
    const sort = fnByName(result, "proc sort");
    expect(sort).toBeDefined();
    expect(sort!.startLine).toBe(1);
    // Spans through the terminating `run;` (line 3).
    expect(sort!.endLine).toBe(3);
  });

  it("(c) a genuine one-line PROC step stays one line", () => {
    const src = "proc print data=a; run;";
    const result = parseSas("p/oneline.sas", src);
    const print = fnByName(result, "proc print");
    expect(print).toBeDefined();
    expect(print!.startLine).toBe(1);
    expect(print!.endLine).toBe(1);
  });

  it("(c') a single-statement step bounded by the next step does not over-reach into it", () => {
    // `proc print data=a;` is the whole step (no body); the following DATA step
    // must NOT be absorbed — proc print stays on its own opener line, data b is
    // a distinct symbol.
    const src = [
      "proc print data=a;", // 1
      "data b;", // 2
      "  set c;", // 3
      "run;", // 4
    ].join("\n");
    const result = parseSas("p/single.sas", src);
    const print = fnByName(result, "proc print");
    expect(print).toBeDefined();
    expect(print!.startLine).toBe(1);
    expect(print!.endLine).toBe(1);
    const b = fnByName(result, "b");
    expect(b?.startLine).toBe(2);
  });
});

describe("parseSas — libname / filename", () => {
  it("captures libname and filename as type symbols", () => {
    const src = ['libname mylib "/data/path";', 'filename myref "/data/file.txt";'].join("\n");
    const result = parseSas("c/refs.sas", src);
    const lib = result.symbols.find((s) => s.kind === "type" && s.name === "mylib");
    const fref = result.symbols.find((s) => s.kind === "type" && s.name === "myref");
    expect(lib).toBeDefined();
    expect(fref).toBeDefined();
  });
});

describe("parseSas — %include", () => {
  it("emits an imports edge for %include", () => {
    const result = parseSas("i/main.sas", '%include "lib/util.sas";');
    const imp = result.edges.find((e) => e.kind === "imports");
    expect(imp?.toQualifiedName).toBe("lib/util.sas");
  });
});

describe("parseSas — rationale hints", () => {
  it("captures statement and block comments, classifying markers", () => {
    const src = [
      "* business rule comment ;",
      "/* block note */",
      "/* TODO refactor this */",
      "/* WHY: keeps TOTAL bounded */",
    ].join("\n");
    const result = parseSas("c/notes.sas", src);

    const note = result.rationaleHints.find((h) => h.text === "business rule comment");
    expect(note?.tag).toBe("NOTE");
    expect(result.rationaleHints.find((h) => h.text === "block note")?.tag).toBe("NOTE");
    expect(result.rationaleHints.find((h) => h.text === "refactor this")?.tag).toBe("TODO");
    expect(result.rationaleHints.find((h) => h.text === "keeps TOTAL bounded")?.tag).toBe("WHY");
  });

  it("does not treat a multiplication '*' or in-string text as a comment", () => {
    const src = ["data t;", "  x = a * b;", '  msg = "* not a comment ;";', "run;"].join("\n");
    const result = parseSas("c/mult.sas", src);
    expect(result.rationaleHints).toHaveLength(0);
  });
});

describe("parseSas — malformed input", () => {
  it("returns unparseable: true on an unterminated block comment", () => {
    const result = parseSas("bad/x.sas", "/* never closes\ndata x; set y; run;");
    expect(result.unparseable).toBe(true);
    expect(result.symbols).toHaveLength(0);
    expect(result.edges).toHaveLength(0);
  });
});

describe("parseSource routing — SAS short-circuit", () => {
  it("routes .sas to parseSas BEFORE the tree-sitter path", async () => {
    // Stub the tree-sitter backend as ready and make it throw if ever called —
    // SAS must never reach parseWithTreeSitter.
    vi.resetModules();
    vi.doMock("../../../src/lib/code-graph/parsers-tree-sitter.js", () => ({
      isTreeSitterReady: () => true,
      parseWithTreeSitter: () => {
        throw new Error("parseWithTreeSitter must not be called for SAS");
      },
      initCodeGraphParsers: vi.fn(),
    }));
    const mod = await import("../../../src/lib/code-graph/parsers.js");
    const result = mod.parseSource("etl/load.sas", "%macro m; %mend;", "sas");
    expect(result.unparseable).toBeFalsy();
    expect(result.symbols.some((s) => s.kind === "function" && s.name === "m")).toBe(true);
    vi.doUnmock("../../../src/lib/code-graph/parsers-tree-sitter.js");
    vi.resetModules();
  });
});
