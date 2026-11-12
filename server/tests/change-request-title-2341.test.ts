/**
 * Issue #2341 — the change request title: what one is called when nobody names
 * it, and what a title may be.
 */
import { describe, expect, it } from "vitest";
import {
  CHANGE_REQUEST_TITLE_MAX,
  changeRequestTitleSchema,
  renameAnalysisSchema,
  startAnalysisSchema,
} from "@metis/shared";
import {
  clampTitle,
  generatedChangeRequestTitle,
  runSourceRecord,
} from "../src/lib/analysis/change-request.js";

const DAY = new Date("2026-11-12T10:00:00Z");

describe("#2341 — generatedChangeRequestTitle", () => {
  it("is the first document's name, with how many more there are", () => {
    expect(
      generatedChangeRequestTitle({
        documentNames: ["Brief.docx"],
        importedTitles: ["Ignored"],
        startedAt: DAY,
      }),
    ).toBe("Brief.docx");
    expect(
      generatedChangeRequestTitle({
        documentNames: ["Brief.docx", "Notes.md", "Spec.pdf"],
        importedTitles: [],
        startedAt: DAY,
      }),
    ).toBe("Brief.docx and 2 more");
  });

  it("is the first imported item's title when no document was chosen", () => {
    expect(
      generatedChangeRequestTitle({
        documentNames: [],
        importedTitles: ["Pay with a saved card", "Refund"],
        startedAt: DAY,
      }),
    ).toBe("Pay with a saved card and 1 more");
  });

  it("quotes the free-text requirements, one line, when there is no source", () => {
    const title = generatedChangeRequestTitle({
      documentNames: [],
      importedTitles: [],
      extraInstructions: "Users can reset their password\nby email.\n" + "x".repeat(200),
      startedAt: DAY,
    });
    expect(title.startsWith("Users can reset their password by email.")).toBe(true);
    expect(title).not.toContain("\n");
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("…")).toBe(true);
  });

  it("falls back to the date, never a blank", () => {
    expect(
      generatedChangeRequestTitle({ documentNames: ["  "], importedTitles: [], startedAt: DAY }),
    ).toBe("Change request of 2026-11-12");
    expect(
      generatedChangeRequestTitle({
        documentNames: [],
        importedTitles: [],
        startedAt: new Date("nope"),
      }),
    ).toBe("Change request of an unknown date");
  });

  it("never exceeds the title limit, even with a long first name and more sources", () => {
    const long = "n".repeat(500);
    for (const docs of [[long], [long, "b"]]) {
      const title = generatedChangeRequestTitle({
        documentNames: docs,
        importedTitles: [],
        startedAt: DAY,
      });
      expect(title.length).toBeLessThanOrEqual(CHANGE_REQUEST_TITLE_MAX);
    }
    expect(
      generatedChangeRequestTitle({
        documentNames: [long, "b"],
        importedTitles: [],
        startedAt: DAY,
      }),
    ).toMatch(/… and 1 more$/);
  });
});

describe("#2341 — clampTitle", () => {
  it("collapses control characters and whitespace to one line", () => {
    expect(clampTitle(" a\u0000b\tc\r\nd ")).toBe("a b c d");
  });
  it("cuts at the limit with an ellipsis", () => {
    expect(clampTitle("abcdef", 4)).toBe("abc…");
    expect(clampTitle("abcd", 4)).toBe("abcd");
  });
});

describe("#2341 — runSourceRecord", () => {
  it("reads the chosen documents and imported items, ignoring junk", () => {
    expect(
      runSourceRecord(
        JSON.stringify({
          documentIds: ["d1", "d1", 7, ""],
          sourceRequirements: [{ requirementId: "r1", title: "T" }, { title: 3 }, null],
          extraInstructions: "Text",
        }),
      ),
    ).toEqual({
      documentIds: ["d1"],
      importedItems: [{ requirementId: "r1", title: "T" }],
      extraInstructions: "Text",
    });
  });
  it("reads nothing from missing or broken metadata", () => {
    for (const raw of [null, undefined, "", "not json", "[1]"]) {
      expect(runSourceRecord(raw)).toEqual({
        documentIds: [],
        importedItems: [],
        extraInstructions: null,
      });
    }
  });
});

describe("#2341 — the title schema", () => {
  it("trims, and accepts markup as plain text", () => {
    expect(changeRequestTitleSchema.parse("  <b>Checkout</b>  ")).toBe("<b>Checkout</b>");
  });
  it("refuses blank, over-long and multi-line titles", () => {
    for (const bad of ["", "   ", "x".repeat(CHANGE_REQUEST_TITLE_MAX + 1), "a\nb", "a\u0007b"]) {
      expect(changeRequestTitleSchema.safeParse(bad).success).toBe(false);
    }
    expect(changeRequestTitleSchema.safeParse("x".repeat(CHANGE_REQUEST_TITLE_MAX)).success).toBe(
      true,
    );
  });
  it("rename takes only a title; start takes an optional one", () => {
    expect(renameAnalysisSchema.safeParse({ title: "A", status: "x" }).success).toBe(false);
    expect(startAnalysisSchema.parse({}).title).toBeUndefined();
    expect(startAnalysisSchema.parse({ title: " A ", startedWithDefaults: true })).toMatchObject({
      title: "A",
      startedWithDefaults: true,
    });
  });
});
