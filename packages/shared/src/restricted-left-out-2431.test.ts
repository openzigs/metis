/**
 * Issue #2431 — an analysis's document search reads as a shared audience, so
 * the passages it left out of restricted documents are counted beside the
 * files and symbols #2437 counts, and said in the same one line.
 */
import { describe, expect, it } from "vitest";
import { readRestrictedLeftOut, restrictedLeftOutSentence } from "./analysis.js";

const WHY =
  "results are shared with the whole project, so they include only what everyone on it can see.";

describe("#2431 — readRestrictedLeftOut with document chunks", () => {
  it("keeps a positive documentChunks count", () => {
    expect(
      readRestrictedLeftOut({ reason: "shared-audience", files: 0, symbols: 0, documentChunks: 4 }),
    ).toEqual({ reason: "shared-audience", files: 0, symbols: 0, documentChunks: 4 });
  });

  it("reads a record written before #2431 (no documentChunks) as before", () => {
    expect(readRestrictedLeftOut({ reason: "shared-audience", files: 2, symbols: 1 })).toEqual({
      reason: "shared-audience",
      files: 2,
      symbols: 1,
    });
  });

  it("drops a zero documentChunks, and reads all-zero counts as nothing left out", () => {
    expect(
      readRestrictedLeftOut({ reason: "shared-audience", files: 1, symbols: 0, documentChunks: 0 }),
    ).toEqual({ reason: "shared-audience", files: 1, symbols: 0 });
    expect(
      readRestrictedLeftOut({ reason: "shared-audience", files: 0, symbols: 0, documentChunks: 0 }),
    ).toBeNull();
  });

  it("reads a malformed documentChunks as null", () => {
    for (const documentChunks of [-1, 1.5, "3", null]) {
      expect(
        readRestrictedLeftOut({ reason: "shared-audience", files: 1, symbols: 0, documentChunks }),
        String(documentChunks),
      ).toBeNull();
    }
  });
});

describe("#2431 — restrictedLeftOutSentence with document chunks", () => {
  it("says the passages alone when no code was left out", () => {
    expect(
      restrictedLeftOutSentence({
        reason: "shared-audience",
        files: 0,
        symbols: 0,
        documentChunks: 3,
      }),
    ).toBe(`3 matching passages from restricted documents were left out: ${WHY}`);
    expect(
      restrictedLeftOutSentence({
        reason: "shared-audience",
        files: 0,
        symbols: 0,
        documentChunks: 1,
      }),
    ).toBe(`1 matching passage from a restricted document was left out: ${WHY}`);
  });

  it("joins two parts with 'and', and three as a list", () => {
    expect(
      restrictedLeftOutSentence({
        reason: "shared-audience",
        files: 2,
        symbols: 0,
        documentChunks: 5,
      }),
    ).toBe(
      `2 restricted files weren't analysed, and 5 matching passages from restricted documents were left out: ${WHY}`,
    );
    expect(
      restrictedLeftOutSentence({
        reason: "shared-audience",
        files: 2,
        symbols: 3,
        documentChunks: 5,
      }),
    ).toBe(
      `2 restricted files weren't analysed, 3 matching code symbols in them were left out, and 5 matching passages from restricted documents were left out: ${WHY}`,
    );
  });
});
