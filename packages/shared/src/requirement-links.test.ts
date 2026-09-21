import { describe, expect, it } from "vitest";

import {
  REQUIREMENT_LINK_TYPES,
  isRequirementLinkType,
  isSelfLink,
  type RequirementLinkType,
} from "./requirement-links.js";

describe("requirement-links shared vocabulary (#623)", () => {
  it("exposes exactly the four allowed link types", () => {
    expect([...REQUIREMENT_LINK_TYPES]).toEqual([
      "relates_to",
      "duplicates",
      "depends_on",
      "derived_from",
    ]);
  });

  describe("isRequirementLinkType", () => {
    it.each(REQUIREMENT_LINK_TYPES)("accepts %s", (t) => {
      expect(isRequirementLinkType(t)).toBe(true);
    });

    it.each(["", "RELATES_TO", "blocks", "relates", " depends_on", null, undefined, 3, {}])(
      "rejects invalid value %o",
      (v) => {
        expect(isRequirementLinkType(v)).toBe(false);
      },
    );

    it("narrows the type for downstream consumers", () => {
      const raw: unknown = "depends_on";
      if (isRequirementLinkType(raw)) {
        const narrowed: RequirementLinkType = raw;
        expect(narrowed).toBe("depends_on");
      } else {
        throw new Error("guard should have accepted depends_on");
      }
    });
  });

  describe("isSelfLink", () => {
    it("is true when source and target ids match", () => {
      expect(isSelfLink("req_1", "req_1")).toBe(true);
    });

    it("is false when source and target differ", () => {
      expect(isSelfLink("req_1", "req_2")).toBe(false);
    });
  });
});
