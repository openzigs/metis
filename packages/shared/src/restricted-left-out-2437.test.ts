/**
 * Issue #2437 — a run that left restricted sources out says how many, and why,
 * in one line; it never names one, and a run that left none out says nothing.
 */
import { describe, expect, it } from "vitest";
import { readRestrictedLeftOut, restrictedLeftOutSentence } from "./analysis.js";

const WHY =
  "results are shared with the whole project, so they include only what everyone on it can see.";

describe("#2437 — readRestrictedLeftOut", () => {
  it("keeps the reason and both counts", () => {
    expect(readRestrictedLeftOut({ reason: "shared-audience", files: 3, symbols: 2 })).toEqual({
      reason: "shared-audience",
      files: 3,
      symbols: 2,
    });
  });

  it("keeps only the counts and the reason, whatever else the stored value holds", () => {
    expect(
      readRestrictedLeftOut({
        reason: "shared-audience",
        files: 1,
        symbols: 0,
        paths: ["src/secret.ts"],
      }),
    ).toEqual({ reason: "shared-audience", files: 1, symbols: 0 });
  });

  it("reads nothing left out as null", () => {
    expect(readRestrictedLeftOut({ reason: "shared-audience", files: 0, symbols: 0 })).toBeNull();
  });

  it("reads a malformed value as null", () => {
    for (const value of [
      undefined,
      null,
      "3",
      [],
      [{ reason: "shared-audience", files: 1, symbols: 0 }],
      { reason: "requester", files: 1, symbols: 0 },
      { files: 1, symbols: 0 },
      { reason: "shared-audience", files: -1, symbols: 2 },
      { reason: "shared-audience", files: 1.5, symbols: 0 },
      { reason: "shared-audience", files: "2", symbols: 0 },
      { reason: "shared-audience", files: 2 },
    ]) {
      expect(readRestrictedLeftOut(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("#2437 — restrictedLeftOutSentence", () => {
  it("says how many files were left out, and why", () => {
    expect(restrictedLeftOutSentence({ reason: "shared-audience", files: 3, symbols: 0 })).toBe(
      `3 restricted files weren't analysed: ${WHY}`,
    );
  });

  it("says one file in the singular", () => {
    expect(restrictedLeftOutSentence({ reason: "shared-audience", files: 1, symbols: 0 })).toBe(
      `1 restricted file wasn't analysed: ${WHY}`,
    );
  });

  it("adds the code symbols left out of the search", () => {
    expect(restrictedLeftOutSentence({ reason: "shared-audience", files: 3, symbols: 5 })).toBe(
      `3 restricted files weren't analysed, and 5 matching code symbols in them were left out: ${WHY}`,
    );
    expect(restrictedLeftOutSentence({ reason: "shared-audience", files: 1, symbols: 1 })).toBe(
      `1 restricted file wasn't analysed, and 1 matching code symbol in it was left out: ${WHY}`,
    );
  });

  it("names symbols alone when no file count was recorded", () => {
    expect(restrictedLeftOutSentence({ reason: "shared-audience", files: 0, symbols: 2 })).toBe(
      `2 matching code symbols in restricted files were left out: ${WHY}`,
    );
  });

  it("says nothing when nothing was left out, or the record is malformed", () => {
    expect(
      restrictedLeftOutSentence({ reason: "shared-audience", files: 0, symbols: 0 }),
    ).toBeNull();
    expect(restrictedLeftOutSentence(undefined)).toBeNull();
    expect(restrictedLeftOutSentence({ reason: "x", files: 3, symbols: 0 })).toBeNull();
  });
});
