/**
 * #160 — COBOL rule miner. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import { mineCblRules, mineCblTokens, renderMinedCblRules } from "./cbl-rule-miner.js";
import { lexCobol } from "./cobol-source.js";
import { MAX_CONTINUATION_LINES } from "./rule-miner-continuation.js";

/** `<indicator><text from column 8>` with a sequence number and an id tag. */
function fixed(lines: string[]): string {
  return lines
    .map((l, i) => `${String(i + 1).padStart(6, "0")}${l.padEnd(66).slice(0, 66)}BILLING1`)
    .join("\n");
}

const BILLING = fixed([
  " DATA DIVISION.",
  " WORKING-STORAGE SECTION.",
  " 01  WS-CUSTOMER.",
  "     05 WS-CUST-TYPE    PIC X.",
  "        88 PREFERRED-CUSTOMER VALUES 'P' 'G'",
  "                                     'V'.",
  "        88 BULK-BUYER   VALUE 'B'.",
  "     05 WS-AGE          PIC 9(3).",
  "        88 SENIOR       VALUE 65 THRU 120.",
  "     05 WS-FILE-STATUS  PIC XX.",
  " PROCEDURE DIVISION.",
  " PRICE-PARA.",
  "     IF WS-AMOUNT > 10000",
  "        AND PREFERRED-CUSTOMER",
  "        PERFORM APPROVAL-PARA",
  "     END-IF",
  "     IF WS-AMOUNT NOT NUMERIC",
  "        MOVE 'E' TO WS-ERR",
  "     END-IF",
  "     IF WS-FILE-STATUS NOT = '00' THEN",
  "        GO TO ERROR-EXIT",
  "     END-IF",
  "     IF WS-AGE < 18 GOBACK END-IF",
  "     EVALUATE WS-CUST-TYPE",
  "        WHEN 'P' PERFORM P-PARA",
  "        WHEN 'G'",
  "        WHEN 'V' PERFORM GV-PARA",
  "        WHEN OTHER CONTINUE",
  "     END-EVALUATE",
  "     EVALUATE TRUE",
  "        WHEN WS-AMOUNT > 500",
  "             AND SENIOR",
  "           MOVE 10 TO WS-DISC",
  "        WHEN WS-AMOUNT > 100 MOVE 5 TO WS-DISC",
  "        WHEN OTHER MOVE 0 TO WS-DISC",
  "     END-EVALUATE",
  "     COMPUTE WS-TOTAL ROUNDED =",
  "        WS-AMOUNT * (1 + WS-TAX-RATE)",
  "        - WS-DISC",
  "        ON SIZE ERROR PERFORM OVERFLOW-PARA",
  "     END-COMPUTE",
  "     COMPUTE WS-NET = WS-TOTAL - WS-FEE.",
]);

describe("mineCblRules (#160)", () => {
  const rules = mineCblRules(BILLING, "src/BILLING.cbl", 1, "BILLING");
  const by = (kind: string) => rules.filter((r) => r.kind === kind);

  it("mines level-88 condition names with their parent item, including multi-line value lists", () => {
    expect(by("condition-name").map((r) => [r.line, r.summary])).toEqual([
      [5, "`PREFERRED-CUSTOMER` (of `WS-CUST-TYPE`) holds when the value is 'P' 'G' 'V'"],
      [7, "`BULK-BUYER` (of `WS-CUST-TYPE`) holds when the value is 'B'"],
      [9, "`SENIOR` (of `WS-AGE`) holds when the value is 65 THRU 120"],
    ]);
  });

  it("reads an IF condition split across lines as one rule at its first line", () => {
    expect(by("condition")).toEqual([
      {
        kind: "condition",
        expression: "IF WS-AMOUNT > 10000 AND PREFERRED-CUSTOMER",
        summary: "Branches when WS-AMOUNT > 10000 AND PREFERRED-CUSTOMER",
        filePath: "src/BILLING.cbl",
        line: 13,
        context: "BILLING",
      },
    ]);
  });

  it("classifies class tests and file-status checks as validations", () => {
    expect(by("validation").map((r) => [r.line, r.summary])).toEqual([
      [17, "Validates WS-AMOUNT NOT NUMERIC"],
    ]);
  });

  it("classifies an IF whose body leaves as a guard, naming a GO TO target", () => {
    expect(by("guard").map((r) => [r.line, r.summary])).toEqual([
      [20, "Rejects/transfers control to ERROR-EXIT when WS-FILE-STATUS NOT = '00'"],
      [23, "Rejects/exits when WS-AGE < 18"],
    ]);
  });

  it("mines EVALUATE on a subject as one dispatch rule, stacked WHENs included, OTHER excluded", () => {
    expect(by("evaluate").map((r) => [r.line, r.summary])).toEqual([
      [24, "State dispatch on `WS-CUST-TYPE` with 3 branches: 'P', 'G', 'V'"],
    ]);
  });

  it("mines each EVALUATE TRUE arm as a condition, reading a multi-line arm whole", () => {
    expect(by("when-condition").map((r) => [r.line, r.summary])).toEqual([
      [31, "Branches when WS-AMOUNT > 500 AND SENIOR"],
      [34, "Branches when WS-AMOUNT > 100"],
    ]);
  });

  it("mines COMPUTE formulas across lines, stopping at ON SIZE ERROR and the period", () => {
    expect(by("compute").map((r) => [r.line, r.summary])).toEqual([
      [37, "Calculates WS-TOTAL = WS-AMOUNT * (1 + WS-TAX-RATE) - WS-DISC (rounded)"],
      [42, "Calculates WS-NET = WS-TOTAL - WS-FEE"],
    ]);
  });

  it("offsets line numbers by baseLine", () => {
    const shifted = mineCblRules(BILLING, "src/BILLING.cbl", 101);
    expect(shifted.map((r) => r.line)).toEqual(rules.map((r) => r.line + 100));
  });

  it("returns rules in line order and honours maxRules", () => {
    const lines = rules.map((r) => r.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
    expect(mineCblRules(BILLING, "x.cbl", 1, null, 2)).toHaveLength(2);
  });

  it("mines nested IFs inside an IF body and EVALUATE inside an EVALUATE", () => {
    const src = [
      "IF A = 1",
      "   IF B = 2",
      "      EVALUATE C",
      "         WHEN 'X' EVALUATE D WHEN 1 CONTINUE WHEN 2 CONTINUE END-EVALUATE",
      "         WHEN 'Y' CONTINUE",
      "      END-EVALUATE",
      "   END-IF",
      "END-IF.",
    ].join("\n");
    const r = mineCblRules(src, "n.cbl", 1);
    expect(r.map((x) => [x.kind, x.line, x.summary])).toEqual([
      ["condition", 1, "Branches when A = 1"],
      ["condition", 2, "Branches when B = 2"],
      ["evaluate", 3, "State dispatch on `C` with 2 branches: 'X', 'Y'"],
      ["evaluate", 4, "State dispatch on `D` with 2 branches: 1, 2"],
    ]);
  });

  it("closes an unterminated EVALUATE at the sentence period", () => {
    const r = mineCblRules("EVALUATE X WHEN 1 CONTINUE.\nEVALUATE Y WHEN 2 CONTINUE.", "p.cbl", 1);
    expect(r.map((x) => x.summary)).toEqual([
      "State dispatch on `X` with 1 branches: 1",
      "State dispatch on `Y` with 1 branches: 2",
    ]);
  });

  it("caps a runaway condition at the line bound and marks it cut", () => {
    const lines = ["IF A = 1"];
    for (let i = 0; i < 30; i++) lines.push(`   OR A = ${i + 2}`);
    lines.push("   CONTINUE.");
    const [r] = mineCblRules(lines.join("\n"), "c.cbl", 1);
    expect(r.expression.endsWith("…")).toBe(true);
    expect(r.expression).toContain(`A = ${MAX_CONTINUATION_LINES}`);
    expect(r.expression).not.toContain(`A = ${MAX_CONTINUATION_LINES + 1}`);
  });

  it("ignores IF / COMPUTE / EVALUATE with nothing to read", () => {
    expect(mineCblRules("IF.\nCOMPUTE X.\nEVALUATE.\nWHEN 1 CONTINUE.", "e.cbl", 1)).toEqual([]);
  });
});

describe("mineCblRules — linear time (#160)", () => {
  /** Tokens read by the miner, counted through a Proxy over the token array. */
  function tokenReads(src: string): { reads: number; tokens: number } {
    const { tokens } = lexCobol(src);
    let reads = 0;
    const counted = new Proxy(tokens, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && /^\d+$/.test(prop)) reads++;
        return Reflect.get(target, prop, receiver);
      },
    });
    mineCblTokens(counted, "p.cbl", 1, null, Number.POSITIVE_INFINITY);
    return { reads, tokens: tokens.length };
  }

  it.each([
    ["IF chains with no terminator", (i: number) => `IF A${i} = 1 AND`],
    ["WHEN arms with no verb", (i: number) => `WHEN A${i} = 1 OR`],
    ["EVALUATE without END-EVALUATE", (i: number) => `EVALUATE X${i}`],
    ["COMPUTE without a period", (i: number) => `COMPUTE X${i} = A + B *`],
    ["88 values with no period", (i: number) => `88 C${i} VALUE 'A' 'B'`],
  ])("reads each token a bounded number of times: %s", (_name, line) => {
    const src = Array.from({ length: 2000 }, (_, i) => line(i)).join("\n");
    const { reads, tokens } = tokenReads(src);
    expect(tokens).toBeGreaterThanOrEqual(4000);
    expect(reads).toBeLessThan(4 * tokens);
  });

  it("stays linear on one very long free-format line of conditions", () => {
    const src = "IF " + "A = 1 AND ".repeat(20_000) + "B = 2 CONTINUE.";
    const { reads, tokens } = tokenReads(src);
    expect(reads).toBeLessThan(4 * tokens);
  });
});

describe("renderMinedCblRules (#160)", () => {
  const rules = mineCblRules(BILLING, "src/BILLING.cbl", 1);

  it("groups rules by kind with one `- L<line>: <summary>` line each", () => {
    const out = renderMinedCblRules(rules);
    expect(out).toContain("### Condition names (level 88) (3)");
    expect(out).toContain("### Formulas (COMPUTE) (2)");
    expect(out).toContain(
      "- L37: Calculates WS-TOTAL = WS-AMOUNT * (1 + WS-TAX-RATE) - WS-DISC (rounded)",
    );
    expect(out.split("\n").filter((l) => l.startsWith("- L"))).toHaveLength(rules.length);
  });

  it("renders nothing for no rules and truncates past maxChars", () => {
    expect(renderMinedCblRules([])).toBe("");
    expect(renderMinedCblRules(rules, 80)).toContain("more COBOL rules truncated");
  });
});
