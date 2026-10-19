/**
 * Issue #1202 — the pure half of the promotion pairing: the keys a row records,
 * how a recorded pairing is resolved against a synthesis output, and how the
 * synthesis join uses it in place of the title match.
 */
import type { SynthesizedRequirement } from "@metis/shared";
import { describe, expect, it } from "vitest";
import {
  itemsGivenTo,
  matchSynthesized,
  planApprovedRequirementSet,
} from "./approved-requirement-set.js";
import {
  pairedInRun,
  pairedItemIndexes,
  pairingColumns,
  synthesisItemKey,
} from "./promotion-pairing.js";
import type { StructuredRequirement } from "./types/requirements.js";

const structured = (id: string, title: string): StructuredRequirement => ({
  id,
  title,
  description: `${title}.`,
  type: "functional",
  stakeholders: [],
  priority: "should-have",
  ambiguities: [],
  evidenceNeeds: [],
  rawSource: "",
});
const item = (title: string, body: string, criterion: string): SynthesizedRequirement => ({
  type: "feature",
  title,
  body,
  priority: "medium",
  labels: [],
  acceptanceCriteria: [criterion],
  evidenceFindingIndexes: [],
});

// Neighbours whose titles hold the same words: level on X by title.
const A = structured("REQ-1", "Mark entries as read");
const B = structured("REQ-2", "Mark read entries");
const X = item("Mark entries read", "Mark entries read from the list.", "X criterion");
const Y = item("Bulk actions", "Mark the selected entries as read.", "Y criterion");
const RUN = "run-1";

describe("synthesisItemKey", () => {
  it("is stable for the same title and body, and differs when either changes", () => {
    expect(synthesisItemKey(X)).toBe(synthesisItemKey({ ...X }));
    expect(synthesisItemKey(X)).not.toBe(synthesisItemKey({ ...X, title: "Other" }));
    expect(synthesisItemKey(X)).not.toBe(synthesisItemKey({ ...X, body: "Other." }));
    expect(synthesisItemKey(X)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("pairedInRun", () => {
  it("needs a structured id and the same extraction run (null matches null)", () => {
    const row = { promotedStructuredId: "REQ-1", promotedStructuredRunId: RUN };
    expect(pairedInRun(row, RUN)).toBe(true);
    expect(pairedInRun(row, "other")).toBe(false);
    expect(pairedInRun(row, null)).toBe(false);
    expect(
      pairedInRun({ promotedStructuredId: "REQ-1", promotedStructuredRunId: null }, null),
    ).toBe(true);
    expect(
      pairedInRun({ promotedStructuredId: "REQ-1", promotedStructuredRunId: null }, undefined),
    ).toBe(true);
    expect(pairedInRun({ promotedStructuredId: null, promotedStructuredRunId: RUN }, RUN)).toBe(
      false,
    );
  });
});

describe("pairedItemIndexes", () => {
  const row = (structuredId: string | null, keys: string | null, runId: string | null = RUN) => ({
    promotedStructuredId: structuredId,
    promotedStructuredRunId: runId,
    promotedSynthesisKeys: keys,
  });

  it("resolves each recorded key to the item's index in this output", () => {
    const out = pairedItemIndexes(
      [
        row("REQ-1", JSON.stringify([synthesisItemKey(Y), synthesisItemKey(X)])),
        row("REQ-2", "[]"),
      ],
      RUN,
      [X, Y],
    );
    expect(Object.fromEntries(out)).toEqual({ "REQ-1": [1, 0], "REQ-2": [] });
  });

  it("leaves out rows with no pairing, another run's, unreadable keys, or an item no longer there", () => {
    const out = pairedItemIndexes(
      [
        row(null, null, null),
        row("REQ-1", JSON.stringify([synthesisItemKey(X)]), "older-run"),
        row("REQ-2", "not json"),
        row("REQ-3", JSON.stringify([1, 2])),
        row("REQ-4", null),
        row("REQ-5", JSON.stringify([synthesisItemKey(X), "gone"])),
      ],
      RUN,
      [X, Y],
    );
    expect(out.size).toBe(0);
  });
});

describe("pairingColumns", () => {
  const from = { runId: RUN, pairings: [{ structuredId: "REQ-1", synthesisKeys: ["k1"] }] };

  it("writes the structured id, run and keys for a paired row", () => {
    expect(pairingColumns(from, 0)).toEqual({
      promotedStructuredId: "REQ-1",
      promotedStructuredRunId: RUN,
      promotedSynthesisKeys: '["k1"]',
    });
  });

  it("writes nothing for a row with no pairing, or with no promotion record at all", () => {
    expect(pairingColumns(from, 1)).toEqual({});
    expect(pairingColumns(undefined, 0)).toEqual({});
  });
});

describe("the synthesis join on a recorded pairing", () => {
  it("baseline — by title alone the neighbours are level on X, and B gets nothing", () => {
    const plan = planApprovedRequirementSet({
      structured: [A, B],
      approvedIds: new Set(["REQ-1", "REQ-2"]),
      synthesis: { summary: "s", requirements: [X, Y] },
    });
    expect(plan.output.requirements.map((r) => r.acceptanceCriteria)).toEqual([[], []]);
  });

  it("A joined on its pairing keeps X, and B is matched among the items no row holds", () => {
    const plan = planApprovedRequirementSet({
      structured: [A, B],
      approvedIds: new Set(["REQ-1", "REQ-2"]),
      synthesis: { summary: "s", requirements: [X, Y] },
      paired: new Map([["REQ-1", [0]]]),
    });
    expect(plan.output.requirements.map((r) => r.acceptanceCriteria)).toEqual([
      ["X criterion"],
      ["Y criterion"],
    ]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.pairings).toEqual([
      { structuredId: "REQ-1", synthesisKeys: [synthesisItemKey(X)] },
      { structuredId: "REQ-2", synthesisKeys: [synthesisItemKey(Y)] },
    ]);
  });

  it("a row that recorded no items is not re-guessed by title", () => {
    const matches = matchSynthesized([A], [X, Y], [A], new Map([["REQ-1", []]]));
    expect(matches.size).toBe(0);
  });

  it("the pairing wins over the item's own structured ids", () => {
    const named = { ...Y, structuredIds: ["REQ-1"] };
    const matches = matchSynthesized([A], [X, named], [A], new Map([["REQ-1", [0]]]));
    expect(matches.get("REQ-1")?.acceptanceCriteria).toEqual(["X criterion"]);
  });

  it("joins several recorded items into one, as the id join does", () => {
    const matches = matchSynthesized([A], [X, Y], [A], new Map([["REQ-1", [0, 1]]]));
    expect(matches.get("REQ-1")?.acceptanceCriteria).toEqual(["X criterion", "Y criterion"]);
  });

  it("itemsGivenTo reports the recorded items, and the id join's, by index", () => {
    const named = { ...Y, structuredIds: ["REQ-2"] };
    expect(
      [
        ...itemsGivenTo({
          structured: [A, B],
          ids: new Set(["REQ-1", "REQ-2"]),
          synthesis: { summary: "s", requirements: [X, named] },
          paired: new Map([["REQ-1", [0]]]),
        }),
      ].sort(),
    ).toEqual([0, 1]);
  });

  // #1253 — rows with no recorded items are replayed as one set. That is what
  // one promotion did, so a single such requirement keeps its replay exactly:
  // level on two items, it took neither, and neither counts as carried.
  it("itemsGivenTo replays one unrecorded requirement exactly, ties included", () => {
    const X2 = item("Mark entries read", "Another body entirely.", "X2 criterion");
    expect(
      itemsGivenTo({
        structured: [A],
        ids: new Set(["REQ-1"]),
        synthesis: { summary: "s", requirements: [X, X2] },
      }),
    ).toEqual(new Set());
  });

  // #1253 — two or more may have been promoted in separate steps, each taking
  // the item they now tie on, so the item counts as carried.
  it("itemsGivenTo counts an item two unrecorded requirements tie on as carried", () => {
    expect(
      itemsGivenTo({
        structured: [A, B],
        ids: new Set(["REQ-1", "REQ-2"]),
        synthesis: { summary: "s", requirements: [X] },
      }),
    ).toEqual(new Set([0]));
    // A recorded row is not replayed, so the other replays alone and takes X.
    expect(
      itemsGivenTo({
        structured: [A, B],
        ids: new Set(["REQ-1", "REQ-2"]),
        synthesis: { summary: "s", requirements: [X] },
        paired: new Map([["REQ-2", []]]),
      }),
    ).toEqual(new Set([0]));
  });

  // #1253 review (F1/F6) — with two unrecorded requirements, an item only ONE
  // of them is level on stays offered: that tie happened in its own step too.
  it("itemsGivenTo does not count an item only one unrecorded requirement is level on", () => {
    const flush = structured("REQ-1", "Flush sessions");
    const exportOrders = structured("REQ-2", "Export orders");
    const X1 = item("Flush sessions", "On logout.", "X1 criterion");
    const X2 = item("Flush sessions", "On password reset.", "X2 criterion");
    const O = item("Export orders", "Export orders as CSV.", "O criterion");
    expect(
      itemsGivenTo({
        structured: [flush, exportOrders],
        ids: new Set(["REQ-1", "REQ-2"]),
        synthesis: { summary: "s", requirements: [X1, X2, O] },
      }),
    ).toEqual(new Set([2]));
  });

  it("an id-joined requirement's pairing records every item that named it", () => {
    const first = { ...X, structuredIds: ["REQ-1"] };
    const second = { ...Y, structuredIds: ["REQ-1"] };
    const plan = planApprovedRequirementSet({
      structured: [A],
      approvedIds: new Set(["REQ-1"]),
      synthesis: { summary: "s", requirements: [first, second] },
    });
    expect(plan.pairings).toEqual([
      { structuredId: "REQ-1", synthesisKeys: [synthesisItemKey(X), synthesisItemKey(Y)] },
    ]);
  });
});
