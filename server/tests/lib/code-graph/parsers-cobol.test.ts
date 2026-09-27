/**
 * Issue #160 — COBOL parser tests.
 *
 * Synthetic fixtures only. `fixed()` builds fixed-format lines column-exactly:
 * a sequence number in columns 1–6, the indicator in column 7, program text
 * from column 8, and an identification tag in columns 73–80 — so the tests
 * prove the sequence and identification areas never reach the graph.
 */
import { describe, expect, it } from "vitest";
import {
  detectLanguage,
  parseSource,
  type ParsedFile,
} from "../../../src/lib/code-graph/parsers.js";
import {
  buildCopybookIndex,
  parseCobol,
  resolveCopybook,
} from "../../../src/lib/code-graph/cobol-parser.js";

/** Fixed-format source: each entry is `<indicator><text from column 8>`. */
function fixed(lines: string[], tag = "ORDERS01"): string {
  return lines
    .map((l, i) => `${String((i + 1) * 100).padStart(6, "0")}${l.padEnd(66).slice(0, 66)}${tag}`)
    .join("\n");
}

const ORDERS = fixed([
  " IDENTIFICATION DIVISION.",
  " PROGRAM-ID. ORDERS.",
  "*WHY: orders over the credit limit are held for review.",
  " ENVIRONMENT DIVISION.",
  " DATA DIVISION.",
  " FILE SECTION.",
  " FD  ORDER-FILE.",
  " 01  ORDER-REC.",
  "     05 OR-AMOUNT       PIC 9(7)V99.",
  " WORKING-STORAGE SECTION.",
  "     COPY CUSTREC.",
  " 01  WS-FLAGS.",
  "     05 WS-ORDER-TYPE   PIC X.",
  "        88 RUSH-ORDER   VALUE 'R'.",
  " 77  WS-TOTAL          PIC 9(9)V99.",
  " PROCEDURE DIVISION.",
  " MAIN-PARA.",
  "     PERFORM INIT-PARA",
  "     PERFORM VALIDATE-PARA THRU VALIDATE-EXIT",
  "     PERFORM UNTIL WS-TOTAL > 100",
  "        ADD 1 TO WS-TOTAL",
  "     END-PERFORM",
  "     PERFORM 3 TIMES",
  "        ADD 1 TO WS-TOTAL",
  "     END-PERFORM",
  "     CALL 'PRICING' USING ORDER-REC",
  "     GOBACK.",
  " init-para.",
  "     MOVE ZERO TO WS-TOTAL.",
  " VALIDATE-PARA.",
  "     IF OR-AMOUNT NOT NUMERIC",
  "        GO TO VALIDATE-EXIT",
  "     END-IF.",
  " VALIDATE-EXIT.",
  "     EXIT.",
  " HOLD-LOGIC SECTION.",
  " HOLD-PARA.",
  "     DISPLAY 'HELD'.",
]);

const FILE = "legacy/orders/ORDERS.cbl";

function names(p: ParsedFile, kind: string): string[] {
  return p.symbols.filter((s) => s.kind === kind).map((s) => s.name);
}

function calls(p: ParsedFile): Array<[string, string, unknown]> {
  return p.edges
    .filter((e) => e.kind === "calls")
    .map((e) => [e.fromQualifiedName.split("::").pop()!, e.toQualifiedName, e.metadata?.via]);
}

describe("COBOL language detection (#160)", () => {
  it.each(["A.cbl", "A.CBL", "a.cob", "a.cobol", "COPY/CUSTREC.cpy"])("%s is COBOL", (f) => {
    expect(detectLanguage(f)).toBe("cbl");
  });

  it("routes .cbl through the COBOL parser even when tree-sitter is booted or not", () => {
    const p = parseSource(FILE, ORDERS, "cbl");
    expect(p.language).toBe("cbl");
    expect(names(p, "class")).toEqual(["ORDERS"]);
  });
});

describe("parseCobol — fixed format (#160)", () => {
  const p = parseCobol(FILE, ORDERS);

  it("yields the program, its sections and paragraphs, and its data items", () => {
    expect(p.unparseable).toBeUndefined();
    expect(names(p, "module")).toEqual(["ORDERS.cbl"]);
    expect(names(p, "class")).toEqual(["ORDERS"]);
    expect(names(p, "function").sort()).toEqual(
      [
        "MAIN-PARA",
        "INIT-PARA",
        "VALIDATE-PARA",
        "VALIDATE-EXIT",
        "HOLD-LOGIC",
        "HOLD-PARA",
      ].sort(),
    );
    expect(names(p, "type").sort()).toEqual(["ORDER-FILE", "ORDER-REC", "WS-FLAGS", "WS-TOTAL"]);
  });

  it("qualifies paragraphs and data items under their program", () => {
    const q = (n: string) => p.symbols.find((s) => s.name === n)!.qualifiedName;
    expect(q("ORDERS")).toBe(`${FILE}::ORDERS`);
    expect(q("MAIN-PARA")).toBe(`${FILE}::ORDERS::MAIN-PARA`);
    expect(q("WS-FLAGS")).toBe(`${FILE}::ORDERS::WS-FLAGS`);
  });

  it("gives each symbol its real line range", () => {
    const at = (n: string) => {
      const s = p.symbols.find((x) => x.name === n)!;
      return [s.startLine, s.endLine];
    };
    // The IDENTIFICATION DIVISION header belongs to the program.
    expect(at("ORDERS")).toEqual([1, 38]);
    expect(at("MAIN-PARA")).toEqual([17, 27]);
    expect(at("INIT-PARA")).toEqual([28, 29]);
    expect(at("VALIDATE-EXIT")).toEqual([34, 35]);
    // A section runs to the next section or the end of the program.
    expect(at("HOLD-LOGIC")).toEqual([36, 38]);
    expect(at("WS-FLAGS")).toEqual([12, 14]);
    expect(at("WS-TOTAL")).toEqual([15, 15]);
  });

  it("records PERFORM, PERFORM THRU, GO TO and CALL edges from the enclosing paragraph", () => {
    expect(calls(p)).toEqual([
      ["MAIN-PARA", "INIT-PARA", "PERFORM"],
      ["MAIN-PARA", "VALIDATE-PARA", "PERFORM"],
      ["MAIN-PARA", "VALIDATE-EXIT", "PERFORM THRU"],
      ["MAIN-PARA", "PRICING", "CALL"],
      ["VALIDATE-PARA", "VALIDATE-EXIT", "GO TO"],
    ]);
  });

  it("does not read an inline PERFORM (UNTIL, n TIMES) as a paragraph call", () => {
    const targets = calls(p).map((c) => c[1]);
    expect(targets).not.toContain("UNTIL");
    expect(targets).not.toContain("3");
  });

  it("records COPY as an imports edge from the program", () => {
    const imports = p.edges.filter((e) => e.kind === "imports");
    expect(imports).toEqual([
      {
        kind: "imports",
        fromQualifiedName: `${FILE}::ORDERS`,
        toQualifiedName: "CUSTREC",
        line: 11,
        metadata: { via: "COPY" },
      },
    ]);
  });

  it("drops the sequence and identification areas", () => {
    const all = p.symbols.map((s) => s.name).concat(p.edges.map((e) => e.toQualifiedName));
    expect(all.some((n) => n.includes("ORDERS01"))).toBe(false);
    expect(all.some((n) => /^0\d{5}/.test(n))).toBe(false);
  });

  it("reads a WHY comment in the indicator area as rationale", () => {
    expect(p.rationaleHints).toEqual([
      {
        startLine: 3,
        endLine: 3,
        tag: "WHY",
        text: "orders over the credit limit are held for review.",
      },
    ]);
  });

  it("does not take a statement continued onto an area-B line as a paragraph", () => {
    const src = fixed([
      " PROCEDURE DIVISION.",
      " MAIN-PARA.",
      "     MOVE WS-A TO",
      "     WS-B.",
      "     STOP RUN.",
    ]);
    expect(names(parseCobol("A.cbl", src), "function")).toEqual(["MAIN-PARA"]);
  });

  it("does not take an area-B name after a full stop as a paragraph (area A rule)", () => {
    const src = fixed([" PROCEDURE DIVISION.", " P1.", "     DISPLAY X.", "     NOT-A-PARA."]);
    expect(names(parseCobol("A.cbl", src), "function")).toEqual(["P1"]);
  });

  it("does not take a free-format continuation line as a paragraph (sentence rule)", () => {
    const src = ["PROCEDURE DIVISION.", "P1.", "MOVE WS-A TO", "WS-B.", "P2.", "  GOBACK."];
    expect(names(parseCobol("A.cbl", src.join("\n")), "function")).toEqual(["P1", "P2"]);
  });

  it("does not take EXIT. or GOBACK. alone on a line as a paragraph", () => {
    const src = fixed([" PROCEDURE DIVISION.", " P1.", " EXIT.", " GOBACK."]);
    expect(names(parseCobol("A.cbl", src), "function")).toEqual(["P1"]);
  });
});

describe("parseCobol — free format and nested programs (#160)", () => {
  const FREE = [
    ">>SOURCE FORMAT FREE",
    "IDENTIFICATION DIVISION.",
    "PROGRAM-ID. PRICING.",
    "DATA DIVISION.",
    "WORKING-STORAGE SECTION.",
    "01 WS-DISC PIC 9(5)V99. *> discount amount",
    "PROCEDURE DIVISION.",
    "MAIN.",
    "    perform Discount-Para",
    '    CALL "AUDIT"',
    "    GOBACK.",
    "DISCOUNT-PARA.",
    "    COMPUTE WS-DISC = 5.",
    "    EXEC SQL INCLUDE SQLCA END-EXEC.",
    "IDENTIFICATION DIVISION.",
    "PROGRAM-ID. HELPER.",
    "PROCEDURE DIVISION.",
    "H1.",
    "    GOBACK.",
    "END PROGRAM HELPER.",
    "END PROGRAM PRICING.",
  ].join("\n");
  const p = parseCobol("src/PRICING.cob", FREE);

  it("reads free format from column 1, upper-casing names", () => {
    expect(names(p, "class").sort()).toEqual(["HELPER", "PRICING"]);
    expect(names(p, "function").sort()).toEqual(["DISCOUNT-PARA", "H1", "MAIN"]);
    expect(calls(p)).toEqual([
      ["MAIN", "DISCOUNT-PARA", "PERFORM"],
      ["MAIN", "AUDIT", "CALL"],
    ]);
  });

  it("nests a contained program and closes each at its END PROGRAM", () => {
    const helper = p.symbols.find((s) => s.name === "HELPER")!;
    const pricing = p.symbols.find((s) => s.name === "PRICING")!;
    expect([helper.startLine, helper.endLine]).toEqual([15, 20]);
    expect([pricing.startLine, pricing.endLine]).toEqual([2, 21]);
    const h1 = p.symbols.find((s) => s.name === "H1")!;
    expect(h1.qualifiedName).toBe("src/PRICING.cob::HELPER::H1");
    // The outer program's last paragraph ends before the nested program starts.
    const disc = p.symbols.find((s) => s.name === "DISCOUNT-PARA")!;
    expect(disc.endLine).toBe(14);
  });

  it("records EXEC SQL INCLUDE as an imports edge", () => {
    expect(p.edges.filter((e) => e.kind === "imports").map((e) => e.toQualifiedName)).toEqual([
      "SQLCA",
    ]);
  });

  it("detects free format without a directive when code starts before column 8", () => {
    const src = [
      "IDENTIFICATION DIVISION.",
      "PROGRAM-ID. X.",
      "PROCEDURE DIVISION.",
      "P1.",
      "  GOBACK.",
    ];
    const q = parseCobol("x.cbl", src.join("\n"));
    expect(names(q, "class")).toEqual(["X"]);
    expect(names(q, "function")).toEqual(["P1"]);
  });
});

describe("parseCobol — copybooks (#160)", () => {
  const CUSTREC = fixed(
    [
      " 01  CUSTOMER-REC.",
      "     05 CU-ID          PIC 9(8).",
      "     05 CU-STATUS      PIC X.",
      "        88 CU-ACTIVE   VALUE 'A'.",
    ],
    "CUSTREC ",
  );

  it("reads a division-less data copybook's records as top-level types", () => {
    const p = parseCobol("copy/CUSTREC.cpy", CUSTREC);
    expect(p.symbols.map((s) => [s.kind, s.qualifiedName])).toEqual([
      ["module", "copy/CUSTREC.cpy"],
      ["type", "copy/CUSTREC.cpy::CUSTOMER-REC"],
    ]);
  });

  it("reads a procedure copybook's paragraphs as top-level functions", () => {
    const p = parseCobol("copy/ERRPARA.cpy", fixed([" ERROR-PARA.", "     DISPLAY 'ERR'."]));
    expect(p.symbols.filter((s) => s.kind === "function").map((s) => s.qualifiedName)).toEqual([
      "copy/ERRPARA.cpy::ERROR-PARA",
    ]);
  });
});

describe("resolveCopybook (#160)", () => {
  const index = buildCopybookIndex([
    "legacy/orders/ORDERS.cbl",
    "legacy/copy/CUSTREC.cpy",
    "legacy/copy/custrec.txt",
    "legacy/a/DUP.cpy",
    "legacy/b/DUP.cpy",
    "legacy/b/USER.cbl",
    "legacy/a/PRICING.cbl",
    "src/app.ts",
  ]);

  it("resolves a copybook by stem, case-insensitively", () => {
    expect(resolveCopybook("CUSTREC", "legacy/orders/ORDERS.cbl", index)).toBe(
      "legacy/copy/CUSTREC.cpy",
    );
    expect(resolveCopybook("custrec", "legacy/orders/ORDERS.cbl", index)).toBe(
      "legacy/copy/CUSTREC.cpy",
    );
  });

  it("accepts a quoted path and uses its last segment", () => {
    expect(resolveCopybook("copy/CUSTREC.cpy", "legacy/orders/ORDERS.cbl", index)).toBe(
      "legacy/copy/CUSTREC.cpy",
    );
  });

  it("prefers the including file's directory when a name is ambiguous", () => {
    expect(resolveCopybook("DUP", "legacy/b/USER.cbl", index)).toBe("legacy/b/DUP.cpy");
    expect(resolveCopybook("DUP", "legacy/orders/ORDERS.cbl", index)).toBeNull();
  });

  it("resolves to a non-.cpy COBOL file only when no copybook has the name", () => {
    expect(resolveCopybook("PRICING", "legacy/orders/ORDERS.cbl", index)).toBe(
      "legacy/a/PRICING.cbl",
    );
  });

  it("returns null for an unknown name and never resolves a file to itself", () => {
    expect(resolveCopybook("NOPE", "legacy/orders/ORDERS.cbl", index)).toBeNull();
    expect(resolveCopybook("USER", "legacy/b/USER.cbl", index)).toBeNull();
  });
});
