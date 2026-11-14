/**
 * #2220 — a similar requirement is listed under a key a reader can use: its
 * structured id (`REQ-003`) or imported item id, never the UUID an elicited
 * requirement's structured id is.
 */
import { describe, expect, it } from "vitest";
import { similarRequirementKey } from "../src/lib/requirements/similar-requirements.js";

describe("similarRequirementKey", () => {
  it("keeps a structured id that is a key", () => {
    expect(similarRequirementKey({ promotedStructuredId: "REQ-003", externalId: null })).toBe(
      "REQ-003",
    );
  });

  it("drops a UUID structured id, falling back to the imported item's id or none", () => {
    const uuid = "3f2b8c1e-9a4d-4e7b-8c21-0d5e6f7a8b9c";
    expect(similarRequirementKey({ promotedStructuredId: uuid, externalId: "PROJ-12" })).toBe(
      "PROJ-12",
    );
    expect(
      similarRequirementKey({ promotedStructuredId: uuid.toUpperCase(), externalId: null }),
    ).toBeNull();
  });

  it("reads a blank structured id as none", () => {
    expect(similarRequirementKey({ promotedStructuredId: "  ", externalId: "42" })).toBe("42");
    expect(similarRequirementKey({ promotedStructuredId: null, externalId: null })).toBeNull();
  });
});
