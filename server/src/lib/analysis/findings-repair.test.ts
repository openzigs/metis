/**
 * #298 — unit tests for the findings field repair. The pipeline-level proof
 * (what `persistAgentResult` receives) is `agentic-findings-repair-pipeline.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";
import { agentOutputSchema } from "@metis/shared";
import {
  NOTE_MAX_LENGTH,
  NOTES_MAX_COUNT,
  answerNeedsDocumentResolution,
  findingsRepairNote,
  repairFinding,
  repairFindingsAnswer,
  repairFindingsAnswerWithDocuments,
  summarizeFindingsRepairs,
  withFindingsRepairNote,
  type FindingsRepair,
} from "./findings-repair.js";

const KNOWN = [
  { id: "doc_loanterms_0001", filename: "Loan Terms.md" },
  { id: "doc_spec_00000001", filename: "Spec.md" },
  { id: "doc_dupe_a_000001", filename: "README.md" },
  { id: "doc_dupe_b_000001", filename: "docs/README.md" },
];
const PATH_AS_ID = "docs/requirements/product/lending/2026/final/Loan Terms.md#chunk4";
const SNIPPET_AS_ID = "x".repeat(300);

function finding(citations: unknown[]) {
  return {
    category: "architecture",
    severity: "medium",
    title: "Loan term is hard-coded",
    body: "body",
    tags: [],
    citations,
  };
}

function answer(citations: unknown[], notes: unknown[] = []) {
  return { agentKey: "code", summary: "s", findings: [finding(citations)], notes };
}

describe("repairFindingsAnswer — citation documentId", () => {
  it("resolves an over-long path naming a known document to that document's id", () => {
    const input = answer([{ documentId: PATH_AS_ID, chunkIndex: 4 }]);
    expect(agentOutputSchema.safeParse(input).success).toBe(false);

    const { value, repairs } = repairFindingsAnswer(input, { knownDocuments: KNOWN });

    const parsed = agentOutputSchema.parse(value);
    expect(parsed.findings[0]!.citations).toEqual([
      { documentId: "doc_loanterms_0001", chunkIndex: 4 },
    ]);
    expect(repairs).toEqual([
      {
        kind: "document-id-resolved",
        path: "findings.0.citations.0",
        originalLength: PATH_AS_ID.length,
      },
    ]);
  });

  it("resolves a too-SHORT bare filename too (the id minimum is 10), case-insensitively", () => {
    const { value, repairs } = repairFindingsAnswer(
      answer([{ documentId: "SPEC.md", chunkIndex: 0 }]),
      { knownDocuments: KNOWN },
    );
    expect(agentOutputSchema.parse(value).findings[0]!.citations[0]).toMatchObject({
      documentId: "doc_spec_00000001",
    });
    expect(repairs.map((r) => r.kind)).toEqual(["document-id-resolved"]);
  });

  it("drops a citation whose invalid id names no document and that has no other identity", () => {
    const { value, repairs } = repairFindingsAnswer(
      answer([
        { documentId: SNIPPET_AS_ID, chunkIndex: 0 },
        { documentId: "doc_loanterms_0001", chunkIndex: 1 },
      ]),
      { knownDocuments: KNOWN },
    );
    const parsed = agentOutputSchema.parse(value);
    // The finding survives; the good citation is untouched.
    expect(parsed.findings).toHaveLength(1);
    expect(parsed.findings[0]!.citations).toEqual([
      { documentId: "doc_loanterms_0001", chunkIndex: 1 },
    ]);
    expect(repairs).toEqual([
      { kind: "citation-dropped", path: "findings.0.citations.0", originalLength: 300 },
    ]);
  });

  it("removes only the id from a citation that is also a complete code citation", () => {
    const { value, repairs } = repairFindingsAnswer(
      answer([{ documentId: SNIPPET_AS_ID, filePath: "src/Loan.java", startLine: 3, endLine: 9 }]),
    );
    expect(agentOutputSchema.parse(value).findings[0]!.citations).toEqual([
      { filePath: "src/Loan.java", startLine: 3, endLine: 9 },
    ]);
    expect(repairs.map((r) => r.kind)).toEqual(["document-id-dropped"]);
  });

  it("does not guess between two documents with the same name", () => {
    const { repairs } = repairFindingsAnswer(
      answer([{ documentId: `${"some/where/else/".repeat(4)}README.md`, chunkIndex: 0 }]),
      { knownDocuments: KNOWN },
    );
    expect(repairs.map((r) => r.kind)).toEqual(["citation-dropped"]);
  });

  it("drops rather than resolves when no document list is supplied", () => {
    const { repairs } = repairFindingsAnswer(answer([{ documentId: PATH_AS_ID, chunkIndex: 0 }]));
    expect(repairs.map((r) => r.kind)).toEqual(["citation-dropped"]);
  });

  it("leaves valid ids alone — real ids and long code-graph ids", () => {
    const codeGraphId = `code-graph:${"a".repeat(200)}`;
    const input = answer(
      [
        { documentId: "doc_loanterms_0001", chunkIndex: 0 },
        { documentId: codeGraphId, chunkIndex: 0 },
      ],
      ["short note"],
    );
    const { value, repairs } = repairFindingsAnswer(input, { knownDocuments: KNOWN });
    expect(repairs).toEqual([]);
    expect(value).toEqual(input);
  });

  it("never mutates its input", () => {
    const input = answer([{ documentId: PATH_AS_ID, chunkIndex: 0 }], ["n".repeat(600)]);
    const before = structuredClone(input);
    repairFindingsAnswer(input, { knownDocuments: KNOWN });
    expect(input).toEqual(before);
  });
});

describe("repairFindingsAnswer — the verdict never depends on the document list (PR #300 review)", () => {
  const LONG_PLAIN_PATH = "docs/requirements/product/lending/2026/final/review/Loan Terms.md";
  const CODE = { filePath: "src/loan.ts", startLine: 1, endLine: 9 };
  // Every branch of the repair: resolvable with and without a chunk, an
  // anchor-only chunk, a code citation, an unresolvable id, a bad chunkIndex.
  const SHAPES: Array<[string, Record<string, unknown>]> = [
    ["resolvable, chunkIndex present", { documentId: PATH_AS_ID, chunkIndex: 4 }],
    ["resolvable, chunkIndex missing, no anchor", { documentId: LONG_PLAIN_PATH }],
    ["resolvable, chunkIndex missing, #chunk anchor", { documentId: PATH_AS_ID }],
    ["resolvable, chunkIndex invalid", { documentId: PATH_AS_ID, chunkIndex: -1 }],
    ["resolvable, also a code citation, no chunkIndex", { documentId: LONG_PLAIN_PATH, ...CODE }],
    ["unresolvable, chunkIndex present", { documentId: SNIPPET_AS_ID, chunkIndex: 0 }],
    ["unresolvable, also a code citation", { documentId: SNIPPET_AS_ID, ...CODE }],
  ];

  for (const [label, citation] of SHAPES) {
    it(`${label}: valid both with and without documents`, () => {
      const input = answer([citation]);
      const without = repairFindingsAnswer(input);
      const withDocs = repairFindingsAnswer(input, { knownDocuments: KNOWN });
      expect(agentOutputSchema.safeParse(without.value).success).toBe(true);
      expect(agentOutputSchema.safeParse(withDocs.value).success).toBe(true);
      // And the finding itself always survives.
      expect(agentOutputSchema.parse(withDocs.value).findings).toHaveLength(1);
      // The same number of citations are touched either way: nothing silent.
      expect(withDocs.repairs).toHaveLength(1);
      expect(without.repairs).toHaveLength(1);
    });
  }

  it("does not resolve a citation that would be an incomplete document citation — it drops it", () => {
    const { value, repairs } = repairFindingsAnswer(answer([{ documentId: LONG_PLAIN_PATH }]), {
      knownDocuments: KNOWN,
    });
    expect(agentOutputSchema.parse(value).findings[0]!.citations).toEqual([]);
    expect(repairs.map((r) => r.kind)).toEqual(["citation-dropped"]);
  });

  it("recovers a missing chunkIndex from the `#chunkN` anchor search_knowledge prints", () => {
    const { value, repairs } = repairFindingsAnswer(answer([{ documentId: PATH_AS_ID }]), {
      knownDocuments: KNOWN,
    });
    expect(agentOutputSchema.parse(value).findings[0]!.citations).toEqual([
      { documentId: "doc_loanterms_0001", chunkIndex: 4 },
    ]);
    expect(repairs.map((r) => r.kind)).toEqual(["document-id-resolved"]);
  });

  it("keeps a resolvable code citation with no chunkIndex as a code citation", () => {
    const { value, repairs } = repairFindingsAnswer(
      answer([{ documentId: LONG_PLAIN_PATH, ...CODE }]),
      { knownDocuments: KNOWN },
    );
    expect(agentOutputSchema.parse(value).findings[0]!.citations).toEqual([CODE]);
    expect(repairs.map((r) => r.kind)).toEqual(["document-id-dropped"]);
  });
});

describe("repairFindingsAnswer — notes", () => {
  it("truncates an over-long note to the limit, with an ellipsis, and records it", () => {
    const long = "Investigated the loan-term configuration. ".repeat(20);
    const { value, repairs } = repairFindingsAnswer(answer([], ["ok", long]));

    const parsed = agentOutputSchema.parse(value);
    expect(parsed.notes[0]).toBe("ok");
    expect(parsed.notes[1]).toHaveLength(NOTE_MAX_LENGTH);
    expect(parsed.notes[1]!.endsWith("…")).toBe(true);
    expect(parsed.notes[1]!.slice(0, 511)).toBe(long.slice(0, 511));
    expect(repairs).toEqual([
      { kind: "note-truncated", path: "notes.1", originalLength: long.length },
    ]);
  });

  it("keeps a note of exactly the limit untouched", () => {
    const exact = "n".repeat(NOTE_MAX_LENGTH);
    expect(repairFindingsAnswer(answer([], [exact])).repairs).toEqual([]);
  });

  it("never splits a surrogate pair before the ellipsis", () => {
    // 510 ASCII chars then emoji: the cut at 511 would land inside the pair.
    const note = "a".repeat(510) + "\u{1F600}".repeat(10);
    const { value } = repairFindingsAnswer(answer([], [note]));
    const out = (value as { notes: string[] }).notes[0]!;
    expect(out).toBe("a".repeat(510) + "…");
    expect(out.length).toBeLessThanOrEqual(NOTE_MAX_LENGTH);
  });
});

describe("the stored limits stay the contract", () => {
  it("NOTE_MAX_LENGTH and NOTES_MAX_COUNT are the schema's own bounds", () => {
    const withNotes = (notes: string[]) => answer([], notes);
    expect(agentOutputSchema.safeParse(withNotes(["n".repeat(NOTE_MAX_LENGTH)])).success).toBe(
      true,
    );
    expect(agentOutputSchema.safeParse(withNotes(["n".repeat(NOTE_MAX_LENGTH + 1)])).success).toBe(
      false,
    );
    expect(agentOutputSchema.safeParse(withNotes(Array(NOTES_MAX_COUNT).fill("n"))).success).toBe(
      true,
    );
    expect(
      agentOutputSchema.safeParse(withNotes(Array(NOTES_MAX_COUNT + 1).fill("n"))).success,
    ).toBe(false);
  });

  it("a genuinely malformed answer is still rejected after repair", () => {
    const malformed = [
      // finding without a title
      { ...answer([{ documentId: PATH_AS_ID, chunkIndex: 0 }]), findings: [{ severity: "low" }] },
      // notes of the wrong type
      { ...answer([]), notes: "not an array" },
      // a note of the wrong type inside the array
      { ...answer([]), notes: [42] },
      // no summary
      { ...answer([]), summary: undefined },
      // a document citation with a valid id but no chunkIndex
      answer([{ documentId: "doc_loanterms_0001" }]),
    ];
    for (const m of malformed) {
      const { value } = repairFindingsAnswer(m, { knownDocuments: KNOWN });
      expect(agentOutputSchema.safeParse(value).success).toBe(false);
    }
  });

  it("passes non-object input through untouched", () => {
    for (const v of [null, "text", 3, [1, 2]]) {
      expect(repairFindingsAnswer(v)).toEqual({ value: v, repairs: [] });
      expect(repairFinding(v, "findings.0")).toEqual({ value: v, repairs: [] });
    }
  });

  it("skips non-object findings and citations rather than throwing", () => {
    const input = {
      summary: "s",
      findings: ["not a finding", { ...finding(["not a citation"]) }, { citations: "nope" }],
      notes: [],
    };
    expect(repairFindingsAnswer(input).repairs).toEqual([]);
  });
});

describe("repairFinding (the salvage unit)", () => {
  it("repairs one finding's citations and labels them with its position", () => {
    const { value, repairs } = repairFinding(
      finding([{ documentId: PATH_AS_ID, chunkIndex: 1 }]),
      "findings.3",
      { knownDocuments: KNOWN },
    );
    expect((value as { citations: unknown[] }).citations).toEqual([
      { documentId: "doc_loanterms_0001", chunkIndex: 1 },
    ]);
    expect(repairs[0]!.path).toBe("findings.3.citations.0");
  });
});

describe("repairFindingsAnswerWithDocuments", () => {
  it("loads documents only when an id needs resolving", async () => {
    const load = vi.fn(async () => KNOWN);
    await repairFindingsAnswerWithDocuments(answer([], ["n".repeat(600)]), load);
    expect(load).not.toHaveBeenCalled();

    const { repairs } = await repairFindingsAnswerWithDocuments(
      answer([{ documentId: PATH_AS_ID, chunkIndex: 0 }]),
      load,
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(repairs.map((r) => r.kind)).toEqual(["document-id-resolved"]);
  });

  it("a failing lookup degrades to dropping the id, never to failing the pass", async () => {
    const { value, repairs } = await repairFindingsAnswerWithDocuments(
      answer([{ documentId: PATH_AS_ID, chunkIndex: 0 }]),
      async () => {
        throw new Error("db down");
      },
    );
    expect(repairs.map((r) => r.kind)).toEqual(["citation-dropped"]);
    expect(agentOutputSchema.safeParse(value).success).toBe(true);
  });

  it("answerNeedsDocumentResolution is false for shapes with no citation ids", () => {
    expect(answerNeedsDocumentResolution(null)).toBe(false);
    expect(answerNeedsDocumentResolution({ findings: "x" })).toBe(false);
    expect(answerNeedsDocumentResolution({ findings: [null, { citations: [1] }] })).toBe(false);
    expect(
      answerNeedsDocumentResolution({ findings: [{ citations: [{ documentId: PATH_AS_ID }] }] }),
    ).toBe(true);
  });
});

describe("recording repairs", () => {
  const repairs: FindingsRepair[] = [
    { kind: "note-truncated", path: "notes.0", originalLength: 900 },
    { kind: "citation-dropped", path: "findings.0.citations.1", originalLength: 300 },
    { kind: "citation-dropped", path: "findings.1.citations.0", originalLength: 280 },
  ];

  it("summarises by kind, in a stable order", () => {
    expect(summarizeFindingsRepairs(repairs)).toBe("2 citation-dropped, 1 note-truncated");
  });

  it("appends one bounded repair note, and none when nothing was repaired", () => {
    const out = withFindingsRepairNote({ notes: ["mine"] }, repairs);
    expect(out.notes).toHaveLength(2);
    expect(out.notes[0]).toBe("mine");
    expect(out.notes[1]).toMatch(/^REPAIRED: 3 over-limit field/);
    expect(out.notes[1]!.length).toBeLessThanOrEqual(NOTE_MAX_LENGTH);
    expect(findingsRepairNote([])).toBeUndefined();
    const untouched = { notes: ["mine"] };
    expect(withFindingsRepairNote(untouched, [])).toBe(untouched);
  });

  it("never overwrites the model's own notes when the array is already full", () => {
    const full = { notes: Array.from({ length: NOTES_MAX_COUNT }, (_, i) => `note ${i}`) };
    expect(withFindingsRepairNote(full, repairs)).toBe(full);
  });

  it("carries no model-authored text", () => {
    const { repairs: made } = repairFindingsAnswer(
      answer([{ documentId: SNIPPET_AS_ID, chunkIndex: 0 }], ["secret ".repeat(100)]),
    );
    const serialized = JSON.stringify(made) + findingsRepairNote(made);
    expect(serialized).not.toContain("xxxx");
    expect(serialized).not.toContain("secret");
  });
});
