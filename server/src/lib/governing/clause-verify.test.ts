/**
 * #1870 — a rule's clause excerpt is stored only when it is in the revision's
 * text verbatim, whitespace aside, and what is stored is the source's own slice.
 */
import { describe, expect, it } from "vitest";
import { MIN_CLAUSE_EXCERPT_WORDS, clauseLocator, locateClause } from "./clause-verify.js";

const TEXT = [
  "# Policy",
  "",
  "**AC-01** Each person who signs in has an individual\nnamed account, never shared.",
  "",
  "**AC-09** Each person who signs in has an individual named account, never shared.",
].join("\n");

describe("locateClause", () => {
  it("finds an excerpt across a line break and returns the source's own slice and offsets", () => {
    const hit = locateClause(
      TEXT,
      "  Each person who signs in has an individual named account, never shared. ",
    );
    expect(hit).not.toBeNull();
    expect(hit!.clauseExcerpt).toBe(TEXT.slice(hit!.clauseStart, hit!.clauseEnd));
    // The first occurrence, which spans the line break, verbatim from the source.
    expect(hit!.clauseExcerpt).toBe(
      "Each person who signs in has an individual\nnamed account, never shared.",
    );
  });

  it("prefers the occurrence inside the section the model was shown", () => {
    const second = TEXT.indexOf("**AC-09**");
    const hit = locateClause(TEXT, "Each person who signs in has an individual named account", {
      start: second,
      end: TEXT.length,
    });
    expect(hit!.clauseStart).toBeGreaterThan(second);
    expect(TEXT.slice(hit!.clauseStart, hit!.clauseEnd)).toBe(
      "Each person who signs in has an individual named account",
    );
    // A preferred range with no occurrence falls back to the first in the text.
    const fallback = locateClause(TEXT, "Each person who signs in", { start: 0, end: 5 });
    expect(fallback!.clauseStart).toBe(TEXT.indexOf("Each person"));
  });

  it("refuses a paraphrase, a changed case, and an excerpt too short to pin a clause", () => {
    expect(
      locateClause(TEXT, "Every person who signs in has an individual named account"),
    ).toBeNull();
    expect(
      locateClause(TEXT, "each person who signs in has an individual named account"),
    ).toBeNull();
    const short = "Each person who signs"
      .split(" ")
      .slice(0, MIN_CLAUSE_EXCERPT_WORDS - 1)
      .join(" ");
    expect(locateClause(TEXT, short)).toBeNull();
    expect(locateClause(TEXT, "   ")).toBeNull();
  });

  it("serves many excerpts from one collapsed text", () => {
    const locate = clauseLocator(TEXT);
    expect(locate("named account, never shared.")?.clauseExcerpt).toBe(
      "named account, never shared.",
    );
    expect(locate("not in the policy at all")).toBeNull();
  });
});
