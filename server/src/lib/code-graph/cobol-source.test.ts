/**
 * #160 — COBOL source normalisation and tokenising. Synthetic fixtures only.
 */
import { describe, expect, it } from "vitest";
import {
  expandTabs,
  lexCobol,
  normalizeCobolSource,
  renderTokens,
  tokenizeCobol,
} from "./cobol-source.js";

/** `<indicator><text from column 8>` with a sequence number and an id tag. */
function fixed(lines: string[]): string {
  return lines
    .map((l, i) => `${String(i + 1).padStart(6, "0")}${l.padEnd(66).slice(0, 66)}PROG0001`)
    .join("\n");
}

const codeOf = (src: string) => normalizeCobolSource(src).map((l) => l.code);

describe("normalizeCobolSource — fixed format (#160)", () => {
  it("keeps columns 8–72 only and one entry per physical line", () => {
    const out = normalizeCobolSource(fixed([" MOVE A TO B.", "*a comment", "/page eject"]));
    expect(out.map((l) => l.code)).toEqual(["MOVE A TO B.", "", ""]);
    expect(out.map((l) => l.comment)).toEqual([null, "a comment", "page eject"]);
    expect(out.every((l) => l.fixed)).toBe(true);
  });

  it("treats a D-indicator debugging line as a comment", () => {
    expect(codeOf(fixed(["D    DISPLAY 'DEBUG'.", " CONTINUE."]))).toEqual(["", "CONTINUE."]);
  });

  it("joins a continued literal, dropping the continuation line's opening quote", () => {
    const src = fixed(["     DISPLAY 'ORDER TOTAL EXCEEDS THE", "-    'CREDIT LIMIT'."]);
    const [first, second] = codeOf(src);
    // The literal runs to column 72 on the first line (padded with spaces).
    expect(first).toBe(`    DISPLAY 'ORDER TOTAL EXCEEDS THE${" ".repeat(29)}CREDIT LIMIT'.`);
    expect(second).toBe("");
  });

  it("joins a continued word directly onto the previous line", () => {
    expect(codeOf(fixed(["     MOVE WS-CUST", "-    OMER-ID TO X."]))[0]).toBe(
      "    MOVE WS-CUSTOMER-ID TO X.",
    );
  });

  it("expands tabs to 8-column stops before reading columns", () => {
    expect(expandTabs("\tA")).toBe("        A");
    expect(expandTabs("ab\tc")).toBe("ab      c");
    expect(expandTabs("no tabs")).toBe("no tabs");
  });

  it("strips an inline *> comment but not one inside a literal", () => {
    const [a, b] = normalizeCobolSource(
      fixed(["     MOVE 1 TO X. *> set x", "     DISPLAY '*> not'."]),
    );
    expect(a).toMatchObject({ code: "    MOVE 1 TO X.", comment: "set x" });
    expect(b.code).toBe("    DISPLAY '*> not'.");
  });
});

describe("normalizeCobolSource — free format and directives (#160)", () => {
  it("reads the whole line when code starts before column 8", () => {
    const out = normalizeCobolSource("PROCEDURE DIVISION.\n    MOVE A TO B.\n*> note");
    expect(out.map((l) => l.code)).toEqual(["PROCEDURE DIVISION.", "    MOVE A TO B.", ""]);
    expect(out[2].comment).toBe("note");
    expect(out.every((l) => !l.fixed)).toBe(true);
  });

  it("switches format at >>SOURCE directives, from the next line on", () => {
    const src = [
      "      >>SOURCE FORMAT IS FREE",
      "MOVE A TO B.",
      ">>SOURCE FORMAT FIXED",
      "000100     MOVE C TO D.                                                  SEQ00001",
    ].join("\n");
    const out = normalizeCobolSource(src);
    expect(out.map((l) => l.code)).toEqual(["", "MOVE A TO B.", "", "    MOVE C TO D."]);
    expect(out.map((l) => l.fixed)).toEqual([false, false, false, true]);
  });

  it("honours a $SET SOURCEFORMAT directive", () => {
    const out = normalizeCobolSource('      $SET SOURCEFORMAT"FREE"\nMOVE A TO B.');
    expect(out.map((l) => l.code)).toEqual(["", "MOVE A TO B."]);
  });
});

describe("tokenizeCobol (#160)", () => {
  const tok = (code: string) =>
    tokenizeCobol([{ code, comment: null, fixed: false }]).map((t) => [t.kind, t.text]);

  it("separates words, numbers, literals, operators and the sentence period", () => {
    expect(tok("IF WS-AMT >= 1.5 AND X = 'A''B'.")).toEqual([
      ["word", "IF"],
      ["word", "WS-AMT"],
      ["op", ">="],
      ["number", "1.5"],
      ["word", "AND"],
      ["word", "X"],
      ["op", "="],
      ["literal", "'A''B'"],
      ["period", "."],
    ]);
  });

  it("reads a numeric paragraph name followed by a period as a number, then a period", () => {
    expect(tok("100.")).toEqual([
      ["number", "100"],
      ["period", "."],
    ]);
    expect(tok("1000-INIT.")).toEqual([
      ["word", "1000-INIT"],
      ["period", "."],
    ]);
  });

  it("marks the first token of each line and upper-cases words only", () => {
    const { tokens } = lexCobol("move 'abc' to x\n  display y");
    expect(tokens.map((t) => [t.upper, t.first, t.line])).toEqual([
      ["MOVE", true, 0],
      ["'abc'", false, 0],
      ["TO", false, 0],
      ["X", false, 0],
      ["DISPLAY", true, 1],
      ["Y", false, 1],
    ]);
  });

  it("reads ** and an unterminated literal to the end of the line", () => {
    expect(tok("A ** 2 'open")).toEqual([
      ["word", "A"],
      ["op", "**"],
      ["number", "2"],
      ["literal", "'open"],
    ]);
  });

  it("renders tokens back without spaces before , ) . or after (", () => {
    const { tokens } = lexCobol("COMPUTE X ( I ) = A , B .");
    expect(renderTokens(tokens)).toBe("COMPUTE X (I) = A, B.");
  });
});
