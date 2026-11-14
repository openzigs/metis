/**
 * #2446 — the stored form of a row's sources, and the pure helpers around it.
 * The reads against a real database (citations resolved, requirements and
 * cross-document findings unioned, every analysis path) are in
 * tests/source-provenance-2446.sqlite.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
  evidenceFindingIds,
  parseSourceIds,
  resolveFindingSourceIds,
  serializeSourceIds,
  sourceIdsOfFindingSets,
  sourceIdsOfFindings,
  unionSourceIds,
  unionStoredSourceIds,
} from "./source-ids.js";

describe("#2446 — stored sources", () => {
  it("serialises sorted, distinct ids, with each citation's own on a finding", () => {
    expect(
      JSON.parse(
        serializeSourceIds({
          documentIds: ["d-2", "d-1", "d-2"],
          chunkIds: ["c-9", "c-1"],
          citations: [
            { documentIds: ["d-2", "d-1"], chunkIds: [] },
            { documentIds: [], chunkIds: ["c-9"] },
          ],
        }),
      ),
    ).toEqual({
      documentIds: ["d-1", "d-2"],
      chunkIds: ["c-1", "c-9"],
      citations: [
        { documentIds: ["d-1", "d-2"], chunkIds: [] },
        { documentIds: [], chunkIds: ["c-9"] },
      ],
    });
    // A requirement's record has no per-citation part.
    expect(JSON.parse(serializeSourceIds({ documentIds: ["d-1"], chunkIds: [] }))).toEqual({
      documentIds: ["d-1"],
      chunkIds: [],
    });
  });

  it("reads back what it wrote, and reads anything else as no record", () => {
    const stored = serializeSourceIds({ documentIds: ["d-1"], chunkIds: ["c-1"], citations: [] });
    expect(parseSourceIds(stored)).toEqual({ documentIds: ["d-1"], chunkIds: ["c-1"] });
    expect(parseSourceIds(serializeSourceIds({ documentIds: [], chunkIds: [] }))).toEqual({
      documentIds: [],
      chunkIds: [],
    });
    for (const raw of [
      null,
      undefined,
      "",
      "not json",
      "null",
      "[]",
      '"d-1"',
      '{"documentIds":["d-1"]}',
      '{"documentIds":"d-1","chunkIds":[]}',
      '{"documentIds":[1],"chunkIds":[]}',
      '{"documentIds":[""],"chunkIds":[]}',
    ]) {
      expect(parseSourceIds(raw), String(raw)).toBeNull();
    }
  });

  it("unions records, sorted and distinct", () => {
    expect(
      unionSourceIds([
        { documentIds: ["d-2"], chunkIds: ["c-2"] },
        { documentIds: ["d-1", "d-2"], chunkIds: [] },
      ]),
    ).toEqual({ documentIds: ["d-1", "d-2"], chunkIds: ["c-2"] });
    expect(unionSourceIds([])).toEqual({ documentIds: [], chunkIds: [] });
  });

  it("a union with a part that is not recorded is not recorded", () => {
    const a = serializeSourceIds({ documentIds: ["d-1"], chunkIds: [] });
    const b = serializeSourceIds({ documentIds: ["d-2"], chunkIds: ["c-2"] });
    expect(JSON.parse(unionStoredSourceIds(a, b)!)).toEqual({
      documentIds: ["d-1", "d-2"],
      chunkIds: ["c-2"],
    });
    expect(unionStoredSourceIds(a, null)).toBeNull();
    expect(unionStoredSourceIds(null, b)).toBeNull();
  });

  it("takes a requirement's evidence findings from its `finding:` labels only", () => {
    expect(
      evidenceFindingIds(["security", "finding:f-2", "finding:", "finding:f-1", "finding:f-2"]),
    ).toEqual(["f-1", "f-2"]);
    expect(evidenceFindingIds([])).toEqual([]);
  });

  it("reads nothing when no finding cites anything", async () => {
    const db = {
      analysis: { findUnique: vi.fn() },
      document: { findMany: vi.fn() },
      knowledgeChunk: { findMany: vi.fn() },
      repoConnection: { findMany: vi.fn() },
    };
    expect(
      await resolveFindingSourceIds(db as never, "an-1", [{ citations: [] }, { citations: null }]),
    ).toEqual([
      { documentIds: [], chunkIds: [], citations: [] },
      { documentIds: [], chunkIds: [], citations: [] },
    ]);
    expect(db.analysis.findUnique).not.toHaveBeenCalled();
  });

  it("refuses to resolve citations for an analysis it cannot find", async () => {
    const db = { analysis: { findUnique: vi.fn(async () => null) } };
    await expect(
      resolveFindingSourceIds(db as never, "an-gone", [
        { citations: [{ documentId: "d-1", chunkIndex: 0 }] },
      ]),
    ).rejects.toThrow(/an-gone/);
  });

  it("a row citing no finding rests on the run as a whole: no record (NULL), and reads nothing", async () => {
    // Synthesis, elicitation and the completeness check read every finding of
    // the run, so a derived row with no evidence is not "drew on nothing" (#2447).
    const db = { finding: { findMany: vi.fn() } };
    expect(await sourceIdsOfFindings(db as never, "an-1", [])).toBeNull();
    expect(await sourceIdsOfFindingSets(db as never, "an-1", [[], []])).toEqual([null, null]);
    expect(db.finding.findMany).not.toHaveBeenCalled();
  });

  it("reads every row's evidence findings in one query, and unions per row", async () => {
    const stored = (documentIds: string[]) => JSON.stringify({ documentIds, chunkIds: [] });
    const db = {
      finding: {
        findMany: vi.fn(async () => [
          { id: "f-1", sourceIds: stored(["d-1"]) },
          { id: "f-2", sourceIds: stored(["d-2"]) },
          { id: "f-legacy", sourceIds: null },
        ]),
      },
    };
    const out = await sourceIdsOfFindingSets(db as never, "an-1", [
      ["f-2", "f-1", "f-2"],
      [],
      ["f-1", "f-legacy"],
      ["f-1", "f-missing"],
      ["f-2"],
    ]);
    expect(db.finding.findMany).toHaveBeenCalledTimes(1);
    expect(db.finding.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["f-1", "f-2", "f-legacy", "f-missing"] },
        agentResult: { analysisId: "an-1" },
      },
      select: {
        id: true,
        sourceIds: true,
        agentResult: { select: { analysis: { select: { sourceAccess: true } } } },
      },
    });
    expect(out.map((v) => (v === null ? null : JSON.parse(v)))).toEqual([
      { documentIds: ["d-1", "d-2"], chunkIds: [] },
      null,
      null,
      null,
      { documentIds: ["d-2"], chunkIds: [] },
    ]);
  });

  it("#2448 — on a starter run every row rests on the run as a whole: no record", async () => {
    // Synthesis read every finding, and there a finding may rest on a
    // restricted file its citations do not name.
    const stored = JSON.stringify({ documentIds: ["d-1"], chunkIds: [] });
    const run = (sourceAccess: string) => ({
      finding: {
        findMany: vi.fn(async () => [
          { id: "f-1", sourceIds: stored, agentResult: { analysis: { sourceAccess } } },
        ]),
      },
    });
    expect(await sourceIdsOfFindingSets(run("starter") as never, "an-1", [["f-1"], []])).toEqual([
      null,
      null,
    ]);
    expect(await sourceIdsOfFindings(run("starter") as never, "an-1", ["f-1"])).toBeNull();
    // A shared run keeps the union of its findings' records.
    expect(await sourceIdsOfFindings(run("shared") as never, "an-1", ["f-1"])).toBe(stored);
  });
});
