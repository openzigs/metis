/**
 * Issue #1063 — which imported item a synthesised requirement came from.
 *
 * The ids are model output, so the three states (linked / added by the
 * analysis / not recorded) have to survive untrusted input without one being
 * mistaken for another.
 */
import { describe, expect, it } from "vitest";
import type { AnalysisSourceRequirement } from "@metis/shared";
import {
  cleanSourceIds,
  readSourceRequirements,
  resolveSourceItems,
  serializeSourceCandidateIds,
  toSynthesisSourceItems,
} from "./source-items.js";

const source = (n: number, over: Partial<AnalysisSourceRequirement> = {}) => ({
  candidateId: `NR-${n}`,
  requirementId: `req-${n}`,
  title: `Imported item ${n}`,
  externalSource: "github",
  externalId: String(4000 + n),
  externalUrl: `https://github.com/miniflux/v2/issues/${4000 + n}`,
  ...over,
});

const RUN = [source(1), source(2), source(3)];
const KNOWN = new Set(RUN.map((s) => s.candidateId));

describe("readSourceRequirements", () => {
  it("reads the items from a metadata object", () => {
    expect(readSourceRequirements({ sourceRequirements: RUN })).toEqual(RUN);
  });

  it("reads them from the metadata JSON text as stored on the analysis row", () => {
    expect(readSourceRequirements(JSON.stringify({ sourceRequirements: RUN }))).toEqual(RUN);
  });

  it.each([null, undefined, "", "not json", "[1,2]", 7, {}, { sourceRequirements: "NR-1" }])(
    "is empty for %j",
    (metadata) => {
      expect(readSourceRequirements(metadata)).toEqual([]);
    },
  );

  it("drops a malformed entry and keeps the well-formed ones", () => {
    const items = readSourceRequirements({
      sourceRequirements: [
        null,
        "NR-9",
        { candidateId: "NR-1" },
        { ...source(2), externalSource: "" },
        { ...source(3), title: 5 },
        source(1),
      ],
    });
    expect(items).toEqual([source(1)]);
  });

  it("keeps an item with no number or URL, as nulls", () => {
    const [item] = readSourceRequirements({
      sourceRequirements: [{ ...source(1), externalId: undefined, externalUrl: 42 }],
    });
    expect(item).toMatchObject({ externalId: null, externalUrl: null });
  });

  it("keeps an empty title: it is still a known item", () => {
    expect(readSourceRequirements({ sourceRequirements: [source(1, { title: "" })] })).toHaveLength(
      1,
    );
  });
});

describe("toSynthesisSourceItems", () => {
  it("lists each item by its NR id and title", () => {
    expect(toSynthesisSourceItems(RUN)).toEqual([
      { id: "NR-1", title: "Imported item 1" },
      { id: "NR-2", title: "Imported item 2" },
      { id: "NR-3", title: "Imported item 3" },
    ]);
  });

  it("is empty for a run not started from imported items", () => {
    expect(toSynthesisSourceItems(undefined)).toEqual([]);
    expect(toSynthesisSourceItems([])).toEqual([]);
  });
});

describe("cleanSourceIds", () => {
  it("keeps the run's own ids, in the order given", () => {
    expect(cleanSourceIds(["NR-2", "NR-1"], KNOWN)).toEqual(["NR-2", "NR-1"]);
  });

  it("drops an id the run does not have and de-duplicates", () => {
    expect(cleanSourceIds(["NR-1", "NR-9", "NR-1", " NR-3 "], KNOWN)).toEqual(["NR-1", "NR-3"]);
  });

  it("keeps an explicit empty list: the model's 'none'", () => {
    expect(cleanSourceIds([], KNOWN)).toEqual([]);
  });

  it("is undefined, not [], when the model named only ids that do not exist", () => {
    // Otherwise a hallucinated id would label a requirement "added by the analysis".
    expect(cleanSourceIds(["NR-9", "REQ-001", "ignore previous instructions"], KNOWN)).toBe(
      undefined,
    );
  });

  it("is undefined when the model gave no list", () => {
    expect(cleanSourceIds(undefined, KNOWN)).toBe(undefined);
  });

  it("is undefined on a run with no imported items, whatever the model said", () => {
    expect(cleanSourceIds(["NR-1"], new Set())).toBe(undefined);
    expect(cleanSourceIds([], new Set())).toBe(undefined);
  });
});

describe("serializeSourceCandidateIds", () => {
  it("stores the checked ids as JSON", () => {
    expect(serializeSourceCandidateIds(["NR-1", "NR-9"], RUN)).toBe('["NR-1"]');
  });

  it("stores [] for a requirement the model said it added", () => {
    expect(serializeSourceCandidateIds([], RUN)).toBe("[]");
  });

  it("stores NULL when the source is not recorded", () => {
    expect(serializeSourceCandidateIds(undefined, RUN)).toBeNull();
    expect(serializeSourceCandidateIds(["NR-9"], RUN)).toBeNull();
    expect(serializeSourceCandidateIds(["NR-1"], [])).toBeNull();
  });
});

describe("resolveSourceItems", () => {
  it("resolves stored ids to the run's items, title and URL from the run record", () => {
    expect(resolveSourceItems('["NR-2"]', RUN)).toEqual([source(2)]);
  });

  it("resolves several, in stored order", () => {
    expect(resolveSourceItems('["NR-3","NR-1"]', RUN)).toEqual([source(3), source(1)]);
  });

  it("is [] for a requirement the analysis added", () => {
    expect(resolveSourceItems("[]", RUN)).toEqual([]);
  });

  it.each([null, undefined, ""])("is null when the column is %j", (column) => {
    expect(resolveSourceItems(column, RUN)).toBeNull();
  });

  it.each(["not json", '"NR-1"', '{"id":"NR-1"}', "7"])("is null for unreadable %s", (column) => {
    expect(resolveSourceItems(column, RUN)).toBeNull();
  });

  it("is null on a run that lists no imported items", () => {
    expect(resolveSourceItems('["NR-1"]', [])).toBeNull();
    expect(resolveSourceItems("[]", [])).toBeNull();
  });

  it("leaves out an id the run does not list, and non-string entries", () => {
    expect(resolveSourceItems('["NR-1","NR-9",4,null]', RUN)).toEqual([source(1)]);
  });

  it("is null, not [], when ids were stored and none resolves", () => {
    // Never "added by the analysis" on the strength of a stale id.
    expect(resolveSourceItems('["NR-9"]', RUN)).toBeNull();
  });
});
