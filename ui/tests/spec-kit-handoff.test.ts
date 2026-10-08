/**
 * #789 — the text "Start analysis with these artifacts" sends.
 */
import { describe, expect, it } from "vitest";
import { MAX_EXTRA_INSTRUCTIONS } from "@metis/shared";
import { buildHandoffInstructions } from "@/lib/spec-kit-handoff";

describe("buildHandoffInstructions", () => {
  it("names the forwarded artifacts and carries the spec", () => {
    const r = buildHandoffInstructions(
      ["specs/001-a/spec.md", "constitution.md"],
      "# Spec\n- FR-1",
    );
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("specs/001-a/spec.md, constitution.md");
    expect(r.text.endsWith("# Spec\n- FR-1")).toBe(true);
  });

  it("sends the header alone when there is no spec text", () => {
    const r = buildHandoffInstructions(["spec.md"], "  ");
    expect(r.text).toMatch(/^Spec Kit handoff \(spec\.md\)\./);
    expect(r.text).not.toContain("\n");
  });

  it("cuts at the server's cap and says so", () => {
    const r = buildHandoffInstructions(["spec.md"], "x".repeat(MAX_EXTRA_INSTRUCTIONS));
    expect(r.truncated).toBe(true);
    expect(r.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS);
  });

  it("is not truncated at exactly the cap", () => {
    const header = buildHandoffInstructions(["spec.md"], null).text;
    const spec = "y".repeat(MAX_EXTRA_INSTRUCTIONS - header.length - 2);
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS);
    expect(r.truncated).toBe(false);
  });
});
