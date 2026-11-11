import { describe, expect, it } from "vitest";
import { parseFrdSource } from "./corpus-source.js";

const SOURCE = `# Booking FRD

Intro paragraph that
wraps onto a second line.

## 1. Scope

[[R1 The system shall send a reminder.]] Background sentence. [[A1 as soon as practical]]

### 1.1 Rules

- [[R2 A patient may hold at most three appointments.]]
1. [[R3 Staff can cancel an appointment.]]
2. Plain numbered item.

| Event | Timing |
|---|---|
| Booking | [[R4 A confirmation is sent within five minutes.]] |

<!-- labels
A1 [vague-term] @R1: practical is vague => How soon is as soon as practical?
A2 [conflict] @R2,R4: the limit and the timing disagree => Which applies?
-->
`;

describe("parseFrdSource", () => {
  const parsed = parseFrdSource(SOURCE);

  it("reads the title, headings, paragraphs, list items and tables, markers stripped", () => {
    expect(parsed.title).toBe("Booking FRD");
    expect(parsed.blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "heading",
      "paragraph",
      "heading",
      "bullet",
      "numbered",
      "numbered",
      "table",
    ]);
    expect(parsed.blocks[1]).toEqual({
      kind: "paragraph",
      text: "Intro paragraph that wraps onto a second line.",
    });
    expect(parsed.blocks[3]).toEqual({
      kind: "paragraph",
      text: "The system shall send a reminder. Background sentence. as soon as practical",
    });
    expect(parsed.blocks[8]).toEqual({
      kind: "table",
      rows: [
        ["Event", "Timing"],
        ["Booking", "A confirmation is sent within five minutes."],
      ],
    });
  });

  it("labels each requirement with its span and the heading above it", () => {
    expect(parsed.labels.sections).toEqual(["Booking FRD", "1. Scope", "1.1 Rules"]);
    expect(parsed.labels.requirements).toEqual([
      { id: "R1", section: "1. Scope", span: "The system shall send a reminder." },
      { id: "R2", section: "1.1 Rules", span: "A patient may hold at most three appointments." },
      { id: "R3", section: "1.1 Rules", span: "Staff can cancel an appointment." },
      { id: "R4", section: "1.1 Rules", span: "A confirmation is sent within five minutes." },
    ]);
  });

  it("gives an ambiguity its own spans and then its requirements' spans", () => {
    const [a1, a2] = parsed.labels.ambiguities;
    expect(a1).toEqual({
      id: "A1",
      kind: "vague-term",
      description: "practical is vague",
      question: "How soon is as soon as practical?",
      requirements: ["R1"],
      spans: ["as soon as practical", "The system shall send a reminder."],
      sections: ["1. Scope"],
    });
    expect(a2!.requirements).toEqual(["R2", "R4"]);
    expect(a2!.spans).toEqual([
      "A patient may hold at most three appointments.",
      "A confirmation is sent within five minutes.",
    ]);
    expect(a2!.sections).toEqual(["1.1 Rules"]);
  });

  it.each([
    ["an unclosed marker", "# T\n\n[[R1 never closed.\n"],
    ["a nested marker", "# T\n\n[[R1 outer [[A1 inner]] text]]\n"],
    ["a requirement marked twice", "# T\n\n[[R1 one.]] [[R1 two.]]\n"],
    ["a marker in a heading", "# T\n\n## [[R1 heading]]\n"],
    ["no title", "## Only a section\n\n[[R1 text.]]\n"],
    ["a malformed trailer line", "# T\n\n[[R1 x.]]\n\n<!-- labels\nnot a label line\n-->\n"],
    [
      "an unknown ambiguity kind",
      "# T\n\n[[R1 x.]]\n\n<!-- labels\nA1 [wobbly] @R1: d => q\n-->\n",
    ],
    [
      "an unknown requirement reference",
      "# T\n\n[[R1 x.]]\n\n<!-- labels\nA1 [missing] @R9: d => q\n-->\n",
    ],
    [
      "an ambiguity described twice",
      "# T\n\n[[R1 x.]]\n\n<!-- labels\nA1 [missing] @R1: d => q\nA1 [missing] @R1: d => q\n-->\n",
    ],
    [
      "an ambiguity with no span and no requirement",
      "# T\n\n[[R1 x.]]\n\n<!-- labels\nA1 [missing]: d => q\n-->\n",
    ],
    ["an ambiguity marked but not described", "# T\n\n[[R1 x.]] [[A1 y]]\n"],
  ])("refuses %s", (_name, source) => {
    expect(() => parseFrdSource(source)).toThrow();
  });
});
