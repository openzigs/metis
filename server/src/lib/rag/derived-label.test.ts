import { describe, expect, it } from "vitest";
import { formatDerivedLabel, readDerivedLabel } from "./derived-label.js";

describe("readDerivedLabel (#199)", () => {
  it("reads the #189 stamp with status and scope", () => {
    const meta = JSON.stringify({
      evidenceClass: "derived-generated-doc",
      generatedDocumentStatus: "degraded",
      generatedDocumentScope: "module",
    });
    expect(readDerivedLabel(meta, "generated")).toEqual({ status: "degraded", scope: "module" });
  });
  it("treats a legacy generated-source chunk as derived with no status", () => {
    expect(readDerivedLabel("{}", "generated")).toEqual({});
    expect(readDerivedLabel(null, "generated")).toEqual({});
  });
  it("is undefined for primary material", () => {
    expect(readDerivedLabel(JSON.stringify({ source: "upload" }), "upload")).toBeUndefined();
  });
  it("survives unparseable or non-object metadata", () => {
    expect(readDerivedLabel("not json", "upload")).toBeUndefined();
    expect(readDerivedLabel("[1]", "generated")).toEqual({});
  });
  it("honours the stamp even when the document source is not generated", () => {
    expect(
      readDerivedLabel(JSON.stringify({ evidenceClass: "derived-generated-doc" }), "upload"),
    ).toEqual({});
  });
});

describe("formatDerivedLabel (#199)", () => {
  it("is empty for primary material", () => expect(formatDerivedLabel(undefined)).toBe(""));
  it("shows degraded and non-full scope", () => {
    expect(formatDerivedLabel({ status: "degraded", scope: "module" })).toBe(
      " [DERIVED: generated documentation, not a primary source; status=degraded; scope=module]",
    );
  });
  it("shows an unknown status but hides ready/full", () => {
    expect(formatDerivedLabel({ status: "weird" })).toContain("status=weird");
    expect(formatDerivedLabel({ status: "ready", scope: "full" })).not.toContain("=");
  });
});
