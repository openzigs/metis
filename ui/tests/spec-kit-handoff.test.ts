/**
 * #789 — the text "Start analysis with these artifacts" sends.
 * #994 — a METIS spec is sent as a structured summary of its requirements.
 */
import { describe, expect, it } from "vitest";
import { MAX_EXTRA_INSTRUCTIONS } from "@metis/shared";
import {
  buildHandoffInstructions,
  specRequirements,
  SPEC_TAIL_OMITTED,
} from "@/lib/spec-kit-handoff";

/** A spec in the shape METIS's `/speckit.specify` writes. */
const METIS_SPEC = [
  "# Spec",
  "Let a user mark entries read in bulk.",
  "",
  "## Stakeholders",
  "- Readers",
  "",
  "## Acceptance criteria",
  "",
  "- **AC-1**: Mark all as read",
  "  - **Given** a feed with unread entries",
  "  - **When** the user marks all as read",
  "  - **Then** every entry is read",
  "  - **Example**: input `3 unread` → output `0 unread`",
  "- **AC-2**: Older than N days",
  "  - **Given** entries of mixed age",
  "  - **When** the user picks 7 days",
  "  - **Then** only entries older than 7 days are read",
  "",
  "## Non-functional requirements",
  "- Bulk update finishes in under 2 seconds for 10,000 entries",
  "- Works without JavaScript",
  "  on the server-rendered page",
].join("\n");

describe("specRequirements (#994)", () => {
  it("reads each criterion as one requirement with its Given/When/Then, then the NFRs", () => {
    expect(specRequirements(METIS_SPEC)).toEqual([
      {
        label: "AC-1",
        text: "Mark all as read. Given a feed with unread entries. When the user marks all as read. Then every entry is read. Example: input `3 unread` → output `0 unread`.",
      },
      {
        label: "AC-2",
        text: "Older than N days. Given entries of mixed age. When the user picks 7 days. Then only entries older than 7 days are read.",
      },
      { label: "NFR-1", text: "Bulk update finishes in under 2 seconds for 10,000 entries." },
      { label: "NFR-2", text: "Works without JavaScript. on the server-rendered page." },
    ]);
  });

  it("reads criteria written as headings", () => {
    const spec = "## Acceptance criteria\n\n### AC-1 Login\nGiven a user\n\n### AC-2: Logout\n";
    expect(specRequirements(spec).map((r) => r.label)).toEqual(["AC-1", "AC-2"]);
    expect(specRequirements(spec)[0]!.text).toBe("Login. Given a user.");
  });

  it("finds nothing in a spec without those sections", () => {
    expect(specRequirements("# Spec\n- FR-1")).toEqual([]);
  });
});

describe("buildHandoffInstructions", () => {
  it("sends every criterion as its own paragraph under a heading naming the artifacts", () => {
    const r = buildHandoffInstructions(["specs/001-a/spec.md", "constitution.md"], METIS_SPEC);
    expect(r.truncated).toBe(false);
    expect(r.omitted).toEqual([]);
    expect(r.sent).toEqual(["AC-1", "AC-2", "NFR-1", "NFR-2"]);
    const blocks = r.text.split("\n\n");
    expect(blocks[0]).toMatch(/^# Spec Kit handoff \(specs\/001-a\/spec\.md, constitution\.md\)/);
    expect(blocks.slice(1).map((b) => b.split(":")[0])).toEqual(["AC-1", "AC-2", "NFR-1", "NFR-2"]);
    // One line per requirement: never split into one requirement per sub-bullet.
    expect(blocks.every((b) => !b.includes("\n"))).toBe(true);
    // Not the spec's other sections.
    expect(r.text).not.toContain("Readers");
  });

  it("leaves out whole requirements that do not fit, and names them", () => {
    const big = (n: number) => `- **AC-${n}**: C${n}\n  - **Then** ${"x".repeat(1500)}`;
    const spec = `## Acceptance criteria\n${[1, 2, 3, 4].map(big).join("\n")}\n- **AC-5**: short\n`;
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.text.length).toBeLessThanOrEqual(MAX_EXTRA_INSTRUCTIONS);
    expect(r.sent).toEqual(["AC-1", "AC-2", "AC-5"]);
    expect(r.omitted).toEqual(["AC-3", "AC-4"]);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("AC-5: short.")).toBe(true);
  });

  it("sends a requirement that ends one under the cap, and leaves out one that ends at it (#994 review)", () => {
    // The server flags `length >= MAX_EXTRA_INSTRUCTIONS` as truncated input, so a
    // structured handoff of exactly the cap must never be emitted.
    const withBody = (n: number) =>
      buildHandoffInstructions(
        ["spec.md"],
        `## Acceptance criteria\n- **AC-1**: ${"y".repeat(n)}.`,
      );
    const fixed = withBody(1).text.length - 1; // header + "\n\nAC-1: " + "."
    const under = withBody(MAX_EXTRA_INSTRUCTIONS - 1 - fixed);
    expect(under.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS - 1);
    expect(under).toMatchObject({ sent: ["AC-1"], omitted: [], truncated: false });
    const at = withBody(MAX_EXTRA_INSTRUCTIONS - fixed);
    expect(at).toMatchObject({ sent: [], omitted: ["AC-1"], truncated: true });
    expect(at.text.length).toBeLessThan(MAX_EXTRA_INSTRUCTIONS);
  });

  it("sends the header alone when there is no spec text", () => {
    const r = buildHandoffInstructions(["spec.md"], "  ");
    expect(r.text).toMatch(/^Spec Kit handoff \(spec\.md\)\./);
    expect(r.text).not.toContain("\n");
    expect(r).toMatchObject({ truncated: false, sent: [], omitted: [] });
  });

  it("sends a spec without acceptance criteria whole when it fits", () => {
    const r = buildHandoffInstructions(["spec.md"], "# Spec\n- FR-1");
    expect(r.truncated).toBe(false);
    expect(r.omitted).toEqual([]);
    expect(r.text.endsWith("# Spec\n- FR-1")).toBe(true);
  });

  it("cuts an unstructured spec between paragraphs, never mid-sentence, and says so", () => {
    const para = (c: string) => `${c.repeat(1000)} ends here.`;
    const spec = [para("a"), para("b"), para("c"), para("d"), para("e")].join("\n\n");
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toEqual([SPEC_TAIL_OMITTED]);
    expect(r.text.length).toBeLessThanOrEqual(MAX_EXTRA_INSTRUCTIONS);
    expect(r.text.endsWith("ends here.")).toBe(true);
    expect(r.text).not.toContain("e".repeat(10));
  });

  it("cuts an unstructured one-line spec at a sentence end", () => {
    const spec = `${"word ".repeat(500)}stop. ${"more ".repeat(500)}`;
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.text.endsWith("stop.")).toBe(true);
  });

  it("is not truncated one under the cap, and never emits text of exactly the cap", () => {
    const headerLength = buildHandoffInstructions(["spec.md"], "x").text.length - 3;
    const under = buildHandoffInstructions(
      ["spec.md"],
      "y".repeat(MAX_EXTRA_INSTRUCTIONS - headerLength - 3),
    );
    expect(under.text).toHaveLength(MAX_EXTRA_INSTRUCTIONS - 1);
    expect(under.truncated).toBe(false);
    // The server flags length >= cap as truncated, so exactly the cap must be cut.
    const at = buildHandoffInstructions(
      ["spec.md"],
      "y".repeat(MAX_EXTRA_INSTRUCTIONS - headerLength - 2),
    );
    expect(at.truncated).toBe(true);
    expect(at.text.length).toBeLessThan(MAX_EXTRA_INSTRUCTIONS);
  });

  it("cuts a spec with no break of its own after the header, never through a surrogate pair", () => {
    const header = buildHandoffInstructions(["spec.md"], "x").text.length - 3;
    const spec = "a".repeat(MAX_EXTRA_INSTRUCTIONS - header - 2 - 1) + "\u{1F600}" + "tail";
    const r = buildHandoffInstructions(["spec.md"], spec);
    expect(r.truncated).toBe(true);
    expect(r.omitted).toEqual([SPEC_TAIL_OMITTED]);
    expect(r.text).toBe(
      "Spec Kit handoff (spec.md). Evaluate the requirements in this spec.md against the current implementation.",
    );
  });
});
