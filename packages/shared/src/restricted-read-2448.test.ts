/**
 * Issue #2448 — the line a run shows when its code was read with the access of
 * the person who ran it, and that included restricted files. Counts only.
 */
import { describe, expect, it } from "vitest";
import { restrictedReadSentence } from "./analysis.js";

describe("#2448 — restrictedReadSentence", () => {
  it("says how many restricted files the run read, and what a reader who can't see one sees", () => {
    expect(restrictedReadSentence(1)).toBe(
      "This analysis read 1 restricted file or document with the access of the person who ran it. " +
        "Anyone who can't see it sees what drew on it as restricted.",
    );
    expect(restrictedReadSentence(3)).toBe(
      "This analysis read 3 restricted files and documents with the access of the person who ran it. " +
        "Anyone who can't see one of them sees what drew on it as restricted.",
    );
  });

  it("says nothing at zero, and for anything that is not a whole count", () => {
    for (const value of [0, undefined, null, -1, 1.5, "3", Number.NaN, {}]) {
      expect(restrictedReadSentence(value), String(value)).toBeNull();
    }
  });
});
