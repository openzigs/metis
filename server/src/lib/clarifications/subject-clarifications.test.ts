/**
 * #2270 — what an impact run's or a portfolio check's document reading gives
 * its clarification dialog to ask about (`clarifiableRequirements`), and the
 * dialog's request schema. The dialog itself, the store and the routes are
 * `tests/subject-clarification-2270.sqlite.test.ts`'s, over a real database.
 */
import { describe, expect, it } from "vitest";
import type { ReadStatement } from "../document-reader/reader.js";
import { citationFor } from "../analysis/question-selection.js";
import { readFromSources } from "../analysis/clarification-dialog.js";
import { clarifiableRequirements, subjectClarifyRequestSchema } from "./subject-clarifications.js";

function statement(over: Partial<ReadStatement> & Pick<ReadStatement, "id">): ReadStatement {
  return {
    kind: "requirement",
    statement: "Search returns results.",
    quote: "Search results are returned.",
    start: 0,
    end: 10,
    sectionId: "S1",
    headingPath: ["4 Search"],
    refersTo: [],
    ...over,
  };
}

const DOC = { documentId: "doc-1", title: "frd.docx" };

describe("#2270 — clarifiableRequirements", () => {
  it("makes one requirement per flagged requirement, constraint or business rule, citing its paragraph", () => {
    const out = clarifiableRequirements(
      {
        statements: [
          statement({
            id: "T1",
            statement: "Search returns results fast.",
            quote: "Search results must be returned fast.",
          }),
          // No GtWR hit: nothing to ask about it.
          statement({ id: "T2", quote: "Each order has exactly one customer." }),
          statement({
            id: "T3",
            kind: "constraint",
            statement: "Exports run nightly where possible.",
            quote: "Exports run nightly where possible, TBD.",
            headingPath: ["5 Export", "5.1 Schedule"],
          }),
          // Background is not a requirement, however vague.
          statement({ id: "T4", kind: "background", quote: "Users want a fast system." }),
        ],
      },
      DOC,
    );
    expect(out).not.toBeNull();
    expect(out!.requirements.map((r) => r.id)).toEqual(["T1", "T3"]);
    const [t1, t3] = out!.requirements;
    expect(t1).toMatchObject({
      title: "Search returns results fast.",
      description: "Search returns results fast.",
      type: "functional",
      rawSource: "Search results must be returned fast.",
      sources: [
        {
          ref: "T1",
          documentId: "doc-1",
          filename: "frd.docx",
          headingPath: ["4 Search"],
          quote: "Search results must be returned fast.",
        },
      ],
    });
    expect(t1!.ambiguities.map((a) => a.field)).toEqual(["R7:fast"]);
    expect(t3!.type).toBe("constraint");
    expect(t3!.ambiguities.map((a) => a.field).sort()).toEqual(["R8:where possible", "TBD:tbd"]);
    expect(out!.totalAmbiguities).toBe(3);
    expect(out!.totalEvidenceNeeds).toBe(0);
    // The dialog reads it as a document-read list (#2235's classified questions)
    // and cites the paragraph a question is about.
    expect(readFromSources(out!.requirements)).toBe(true);
    expect(citationFor(t1, "R7:fast")).toEqual({
      documentId: "doc-1",
      filename: "frd.docx",
      headingPath: ["4 Search"],
      quote: "Search results must be returned fast.",
    });
  });

  it("is null when no requirement has a flag: there is nothing to ask", () => {
    expect(
      clarifiableRequirements(
        { statements: [statement({ id: "T1", quote: "Each order has one customer." })] },
        DOC,
      ),
    ).toBeNull();
    expect(clarifiableRequirements({ statements: [] }, DOC)).toBeNull();
  });

  it("clips a long statement's title and keeps it whole in the description", () => {
    const long = `${"The export ".repeat(20)}runs fast.`;
    const out = clarifiableRequirements(
      { statements: [statement({ id: "T1", statement: long, quote: "It runs fast." })] },
      DOC,
    );
    const [r] = out!.requirements;
    expect(r!.title.length).toBe(120);
    expect(r!.title.endsWith("...")).toBe(true);
    expect(r!.description).toBe(long);
  });
});

describe("#2270 — subjectClarifyRequestSchema", () => {
  it("takes answers or nothing, and never a requirement list", () => {
    expect(subjectClarifyRequestSchema.safeParse({}).success).toBe(true);
    expect(
      subjectClarifyRequestSchema.safeParse({ answers: [{ questionId: "q-1", answer: "EU" }] })
        .success,
    ).toBe(true);
    expect(
      subjectClarifyRequestSchema.safeParse({ requirements: { requirements: [] } }).success,
    ).toBe(false);
    expect(
      subjectClarifyRequestSchema.safeParse({ answers: [{ questionId: "", answer: "x" }] }).success,
    ).toBe(false);
  });
});
