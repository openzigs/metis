import { describe, expect, it } from "vitest";
import {
  GOVERNING_PREVIEW,
  GOVERNING_PREVIEW_LABEL,
  GOVERNING_PREVIEW_NOTE,
} from "./governing-preview.js";
import { findForbiddenComplianceClaims, neutraliseComplianceClaims } from "./governing-wording.js";
import * as shared from "./index.js";

describe("governing Preview mark (#2109)", () => {
  it("is on, owner decision on #2108, until governing-03 passes its bars", () => {
    expect(GOVERNING_PREVIEW).toBe(true);
  });

  it("is exported from the package root, so the UI and the BRD read one setting", () => {
    expect(shared.GOVERNING_PREVIEW).toBe(GOVERNING_PREVIEW);
    expect(shared.GOVERNING_PREVIEW_LABEL).toBe("Preview");
    expect(shared.GOVERNING_PREVIEW_NOTE).toBe(GOVERNING_PREVIEW_NOTE);
  });

  it("says the checks can miss or misapply rules, and asks for each finding to be reviewed", () => {
    expect(GOVERNING_PREVIEW_NOTE).toBe(
      "Governing checks can miss rules or flag ones that don't apply. Review each finding before relying on it.",
    );
  });

  it("never claims compliance (#1875)", () => {
    for (const text of [GOVERNING_PREVIEW_LABEL, GOVERNING_PREVIEW_NOTE]) {
      expect(findForbiddenComplianceClaims(text)).toEqual([]);
      expect(neutraliseComplianceClaims(text)).toBe(text);
      expect(text.toLowerCase()).not.toContain("compliant");
    }
  });
});
