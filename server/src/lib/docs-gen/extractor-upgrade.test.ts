/**
 * #1071 (PR #1104, review cycles 2 and 3) — when a difference in a document's
 * inputs may be put down to a code-graph extractor upgrade.
 *
 * The first rule inferred the upgrade from an OLD record lacking a field newer
 * ones carry, and suppressed every later graph-only change for ever. The
 * second took one mark for the whole project and compared it with the
 * version's date: a real change in graph B was acknowledged because graph A
 * had been upgraded, and a mark ahead of the version's clock acknowledged a
 * later real change. The cases below pin what makes the rule narrow now: the
 * evidence is the mark of the VERY GRAPH whose rows differ, compared with the
 * mark the baseline recorded for that graph and with nothing else, and it is
 * acknowledged exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintInputs, type GraphStates } from "./regeneration-plan.js";

const db = vi.hoisted(() => ({
  findAck: vi.fn(),
  upsertAck: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    generatedDocumentAcknowledgement: { findUnique: db.findAck, upsert: db.upsertAck },
  },
}));

const {
  acknowledgeExtractorUpgrade,
  hasUnrecordedMark,
  isAttributableToUpgrade,
  settleExtractorUpgrade,
} = await import("./extractor-upgrade.js");

const iso = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
/** Graph `a` and graph `b`: rows digest and mark (seconds; null: never upgraded). */
const graphs = (
  a: [rows: string, mark: number | null],
  b?: [rows: string, mark: number | null],
): GraphStates => ({
  a: { rows: a[0], mark: a[1] === null ? null : iso(a[1]) },
  ...(b ? { b: { rows: b[0], mark: b[1] === null ? null : iso(b[1]) } } : {}),
});

const ITEMS = { "symbol:a": "1", "edge:b": "1", "source:c": "1", settings: "s" };
/** Graph rows rewritten, nothing else. */
const REWRITTEN = { ...ITEMS, "symbol:a": "2", "edge:b": "2" };
/** Graph rows rewritten again. */
const REWRITTEN_AGAIN = { ...ITEMS, "symbol:a": "2", "edge:b": "3" };
/** Graph rows rewritten AND a source file changed. */
const EDITED = { ...REWRITTEN, "source:c": "2" };

const published = fingerprintInputs(ITEMS, graphs(["r1", null]));
const rewritten = fingerprintInputs(REWRITTEN, graphs(["r2", 20]));
const latest = { version: 3 };
const settle = (args: Partial<Parameters<typeof settleExtractorUpgrade>[0]> = {}) =>
  settleExtractorUpgrade({ documentId: "d", latest, published, current: rewritten, ...args });
const ackRow = (version: number, snapshot: { fingerprint: string; graphs?: GraphStates }) => ({
  documentId: "d",
  version,
  upgradedAt: new Date(0),
  fingerprint: snapshot.fingerprint,
  graphs: snapshot.graphs ? JSON.stringify(snapshot.graphs) : null,
  updatedAt: new Date(0),
});
const upserted = (
  version: number,
  snapshot: { fingerprint: string; graphs?: GraphStates },
  latestMark: string | null,
) => {
  const data = {
    version,
    upgradedAt: new Date(latestMark ?? 0),
    fingerprint: snapshot.fingerprint,
    graphs: snapshot.graphs ? JSON.stringify(snapshot.graphs) : null,
  };
  return { where: { documentId: "d" }, create: { documentId: "d", ...data }, update: data };
};

beforeEach(() => {
  vi.clearAllMocks();
  db.findAck.mockResolvedValue(null);
  db.upsertAck.mockResolvedValue({});
});

describe("isAttributableToUpgrade", () => {
  it("one graph: its rows differ and its mark is not the one the baseline recorded", () => {
    expect(isAttributableToUpgrade(graphs(["r1", null]), graphs(["r2", 20]))).toBe(true);
    expect(isAttributableToUpgrade(graphs(["r1", 10]), graphs(["r2", 20]))).toBe(true);
  });

  it("not when the mark did not move: the rows changed for another reason", () => {
    expect(isAttributableToUpgrade(graphs(["r1", 20]), graphs(["r2", 20]))).toBe(false);
    expect(isAttributableToUpgrade(graphs(["r1", null]), graphs(["r2", null]))).toBe(false);
  });

  it("not when the graph has no mark now, whatever the baseline recorded", () => {
    expect(isAttributableToUpgrade(graphs(["r1", 20]), graphs(["r2", null]))).toBe(false);
  });

  it("compares marks for identity, never for order: an EARLIER mark is another mark", () => {
    // A writer whose clock ran behind the previous one's still moved the mark.
    expect(isAttributableToUpgrade(graphs(["r1", 20]), graphs(["r2", 5]))).toBe(true);
  });

  it("two graphs: EVERY graph whose rows differ needs its own moved mark", () => {
    const base = graphs(["a1", null], ["b1", null]);
    // A upgraded, B untouched.
    expect(isAttributableToUpgrade(base, graphs(["a2", 20], ["b1", null]))).toBe(true);
    // A upgraded, and B's rows changed with no upgrade of B: a real change.
    expect(isAttributableToUpgrade(base, graphs(["a2", 20], ["b2", null]))).toBe(false);
    // The other way round.
    expect(isAttributableToUpgrade(base, graphs(["a2", null], ["b2", 20]))).toBe(false);
    // Both upgraded.
    expect(isAttributableToUpgrade(base, graphs(["a2", 20], ["b2", 21]))).toBe(true);
    // B's mark moved, but it is A's rows that differ.
    expect(isAttributableToUpgrade(base, graphs(["a2", null], ["b1", 20]))).toBe(false);
  });

  it("a graph that appeared or went is a real change, marked or not", () => {
    expect(isAttributableToUpgrade(graphs(["a1", null]), graphs(["a1", null], ["b1", 20]))).toBe(
      false,
    );
    expect(isAttributableToUpgrade(graphs(["a1", null], ["b1", 5]), graphs(["a1", null]))).toBe(
      false,
    );
  });

  it("a graph that appeared or went beside a genuine upgrade of another is still a real change", () => {
    // A was upgraded; B is new to the document.
    expect(isAttributableToUpgrade(graphs(["a1", null]), graphs(["a2", 20], ["b1", null]))).toBe(
      false,
    );
    expect(isAttributableToUpgrade(graphs(["a1", null]), graphs(["a2", 20], ["b1", 21]))).toBe(
      false,
    );
    // A was upgraded; B is gone from it.
    expect(isAttributableToUpgrade(graphs(["a1", null], ["b1", null]), graphs(["a2", 20]))).toBe(
      false,
    );
  });

  it("no differing graph at all is nothing to attribute", () => {
    expect(isAttributableToUpgrade(graphs(["a1", null]), graphs(["a1", 20]))).toBe(false);
    expect(isAttributableToUpgrade({}, {})).toBe(false);
  });

  it("a snapshot that recorded no graphs is never the CURRENT side of an upgrade", () => {
    expect(isAttributableToUpgrade(graphs(["a1", null]), undefined)).toBe(false);
    expect(isAttributableToUpgrade(undefined, undefined)).toBe(false);
  });

  describe("a baseline recorded before graphs were (no attribution possible)", () => {
    it("every graph the document reads must carry a mark", () => {
      expect(isAttributableToUpgrade(undefined, graphs(["a2", 20]))).toBe(true);
      expect(isAttributableToUpgrade(undefined, graphs(["a2", 20], ["b2", 21]))).toBe(true);
      expect(isAttributableToUpgrade(undefined, graphs(["a2", 20], ["b2", null]))).toBe(false);
      expect(isAttributableToUpgrade(undefined, graphs(["a2", null], ["b2", 21]))).toBe(false);
      expect(isAttributableToUpgrade(undefined, graphs(["a2", null]))).toBe(false);
    });

    it("and there must be a graph", () => {
      expect(isAttributableToUpgrade(undefined, {})).toBe(false);
    });
  });
});

describe("hasUnrecordedMark", () => {
  it("false while every graph carries the mark the baseline recorded for it", () => {
    expect(hasUnrecordedMark(graphs(["a1", null]), graphs(["a2", null]))).toBe(false);
    expect(
      hasUnrecordedMark(graphs(["a1", 20], ["b1", null]), graphs(["a1", 20], ["b1", null])),
    ).toBe(false);
    expect(hasUnrecordedMark(graphs(["a1", null]), undefined)).toBe(false);
  });

  it("true when any graph's mark is another one, later or earlier or gone", () => {
    expect(hasUnrecordedMark(graphs(["a1", null]), graphs(["a1", 20]))).toBe(true);
    expect(hasUnrecordedMark(graphs(["a1", 20]), graphs(["a1", 30]))).toBe(true);
    expect(hasUnrecordedMark(graphs(["a1", 20]), graphs(["a1", 10]))).toBe(true);
    expect(hasUnrecordedMark(graphs(["a1", 20]), graphs(["a1", null]))).toBe(true);
    expect(hasUnrecordedMark(graphs(["a1", 20], ["b1", 5]), graphs(["a1", 20], ["b1", 6]))).toBe(
      true,
    );
  });

  it("a graph the baseline did not hold counts only when it carries a mark", () => {
    expect(hasUnrecordedMark(graphs(["a1", null]), graphs(["a1", null], ["b1", null]))).toBe(false);
    expect(hasUnrecordedMark(graphs(["a1", null]), graphs(["a1", null], ["b1", 20]))).toBe(true);
  });

  it("a baseline that recorded no graphs has seen no mark", () => {
    expect(hasUnrecordedMark(undefined, graphs(["a1", null]))).toBe(false);
    expect(hasUnrecordedMark(undefined, graphs(["a1", null], ["b1", 20]))).toBe(true);
  });
});

describe("acknowledgeExtractorUpgrade", () => {
  it("keeps one row per document: the fingerprint, each graph's state, and the latest mark among them", async () => {
    const snapshot = { fingerprint: "f", graphs: graphs(["a1", 20], ["b1", 30]) };
    await acknowledgeExtractorUpgrade(
      { generatedDocumentAcknowledgement: { upsert: db.upsertAck } } as never,
      "d",
      4,
      snapshot,
    );
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(4, snapshot, iso(30)));
  });

  it("the latest mark is the latest, whichever graph comes first", async () => {
    const snapshot = { fingerprint: "f", graphs: graphs(["a1", 30], ["b1", 20]) };
    await acknowledgeExtractorUpgrade(
      { generatedDocumentAcknowledgement: { upsert: db.upsertAck } } as never,
      "d",
      4,
      snapshot,
    );
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(4, snapshot, iso(30)));
  });

  it("a snapshot with no marked graph is recorded against the epoch", async () => {
    const snapshot = { fingerprint: "f", graphs: graphs(["a1", null]) };
    await acknowledgeExtractorUpgrade(
      { generatedDocumentAcknowledgement: { upsert: db.upsertAck } } as never,
      "d",
      4,
      snapshot,
    );
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(4, snapshot, null));
    db.upsertAck.mockClear();
    await acknowledgeExtractorUpgrade(
      { generatedDocumentAcknowledgement: { upsert: db.upsertAck } } as never,
      "d",
      4,
      { fingerprint: "f" },
    );
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(4, { fingerprint: "f" }, null));
  });
});

describe("settleExtractorUpgrade", () => {
  describe("a project no upgrade rewrote reads nothing more than before", () => {
    it("unchanged: the inputs are the published ones, under the marks they were published with", async () => {
      expect(await settle({ current: published })).toEqual({ outcome: "unchanged" });
      expect(db.findAck).not.toHaveBeenCalled();
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: more than graph rows differ — the acknowledgement is not read", async () => {
      const edited = fingerprintInputs(EDITED, graphs(["r2", 20]));
      expect(await settle({ current: edited })).toEqual({ outcome: "changed" });
      expect(db.findAck).not.toHaveBeenCalled();
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: a graph-rows-only difference with NO mark on the graph", async () => {
      const current = fingerprintInputs(REWRITTEN, graphs(["r2", null]));
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });
  });

  it("changed: the mark is the one the version was generated against — whatever any clock says", async () => {
    // The version was generated after that upgrade, and recorded its mark.
    const generatedAfter = fingerprintInputs(ITEMS, graphs(["r1", 20]));
    expect(await settle({ published: generatedAfter })).toEqual({ outcome: "changed" });
    expect(db.upsertAck).not.toHaveBeenCalled();
  });

  it("acknowledged: the differing graph's mark moved — recorded for the document's version", async () => {
    expect(await settle()).toEqual({ outcome: "acknowledged" });
    expect(db.findAck).toHaveBeenCalledExactlyOnceWith({ where: { documentId: "d" } });
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, rewritten, iso(20)));
  });

  describe("two graphs under one document (review cycle 3)", () => {
    const both = fingerprintInputs(ITEMS, graphs(["a1", null], ["b1", null]));

    it("changed: graph A upgraded and graph B's rows really changed in the same refresh", async () => {
      const current = fingerprintInputs(REWRITTEN, graphs(["a2", 20], ["b2", null]));
      expect(await settle({ published: both, current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("acknowledged: graph A upgraded, graph B untouched", async () => {
      const current = fingerprintInputs(REWRITTEN, graphs(["a2", 20], ["b1", null]));
      expect(await settle({ published: both, current })).toEqual({ outcome: "acknowledged" });
    });

    it("acknowledged twice: A at one refresh, B at a later one — each against its own mark", async () => {
      const afterA = fingerprintInputs(REWRITTEN, graphs(["a2", 20], ["b1", null]));
      db.findAck.mockResolvedValue(ackRow(3, afterA));
      const afterB = fingerprintInputs(REWRITTEN_AGAIN, graphs(["a2", 20], ["b2", 30]));
      expect(await settle({ published: both, current: afterB })).toEqual({
        outcome: "acknowledged",
      });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, afterB, iso(30)));
    });

    it("changed: after A was acknowledged, A's rows change again while B is upgraded", async () => {
      const afterA = fingerprintInputs(REWRITTEN, graphs(["a2", 20], ["b1", null]));
      db.findAck.mockResolvedValue(ackRow(3, afterA));
      const current = fingerprintInputs(REWRITTEN_AGAIN, graphs(["a3", 20], ["b2", 30]));
      expect(await settle({ published: both, current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });
  });

  describe("once acknowledged", () => {
    beforeEach(() => {
      db.findAck.mockResolvedValue(ackRow(3, rewritten));
    });

    it("unchanged: the acknowledged inputs are the baseline, and nothing is written", async () => {
      expect(await settle()).toEqual({ outcome: "unchanged" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: the NEXT graph-rows-only difference, under the same mark, regenerates", async () => {
      const current = fingerprintInputs(REWRITTEN_AGAIN, graphs(["r3", 20]));
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("unchanged: back at the manifest's own inputs — and the baseline moves back with them", async () => {
      const back = fingerprintInputs(ITEMS, graphs(["r1", 20]));
      expect(await settle({ current: back })).toEqual({ outcome: "unchanged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, back, iso(20)));
    });

    it("acknowledged again: a SECOND upgrade leaves another mark", async () => {
      const current = fingerprintInputs(REWRITTEN_AGAIN, graphs(["r3", 30]));
      expect(await settle({ current })).toEqual({ outcome: "acknowledged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, current, iso(30)));
    });

    it("changed: a second upgrade together with a source change", async () => {
      const current = fingerprintInputs(EDITED, graphs(["r3", 30]));
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: an acknowledgement that recorded no graphs attributes nothing", async () => {
      // Written before graphs were kept, or unreadable: it is not an "older
      // published baseline", so the all-graphs-marked rule does not apply.
      const current = fingerprintInputs(REWRITTEN_AGAIN, graphs(["r3", 30]));
      db.findAck.mockResolvedValue(ackRow(3, { fingerprint: rewritten.fingerprint }));
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      db.findAck.mockResolvedValue({ ...ackRow(3, rewritten), graphs: "{not json" });
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      db.findAck.mockResolvedValue({ ...ackRow(3, rewritten), graphs: '{"a":{"rows":1}}' });
      expect(await settle({ current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });
  });

  describe("a mark that moved without moving the inputs is adopted as seen", () => {
    // The upgrade rewrote nothing this document reads. Left unrecorded, that
    // mark would be evidence for the next, unrelated graph-only change.
    const marked = fingerprintInputs(ITEMS, graphs(["r1", 20]));

    it("unchanged, and recorded once", async () => {
      expect(await settle({ current: marked })).toEqual({ outcome: "unchanged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, marked, iso(20)));
    });

    it("not recorded again while the mark stays", async () => {
      db.findAck.mockResolvedValue(ackRow(3, marked));
      expect(await settle({ current: marked })).toEqual({ outcome: "unchanged" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: the later graph-only change under that same mark regenerates", async () => {
      db.findAck.mockResolvedValue(ackRow(3, marked));
      expect(await settle()).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("the same for a mark that moves after an acknowledgement", async () => {
      db.findAck.mockResolvedValue(ackRow(3, rewritten));
      const movedOn = fingerprintInputs(REWRITTEN, graphs(["r2", 30]));
      expect(await settle({ current: movedOn })).toEqual({ outcome: "unchanged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, movedOn, iso(30)));
    });
  });

  describe("a version published before graphs were recorded", () => {
    const legacy = fingerprintInputs(ITEMS);

    it("changed, as ever: no mark on the graph", async () => {
      const current = fingerprintInputs(REWRITTEN, graphs(["r2", null]));
      expect(await settle({ published: legacy, current })).toEqual({ outcome: "changed" });
      expect(await settle({ published: legacy, current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("unchanged, reading nothing: no mark and the same inputs", async () => {
      const current = fingerprintInputs(ITEMS, graphs(["r1", null]));
      expect(await settle({ published: legacy, current })).toEqual({ outcome: "unchanged" });
      expect(db.findAck).not.toHaveBeenCalled();
    });

    it("acknowledged: its one graph was upgraded", async () => {
      expect(await settle({ published: legacy })).toEqual({ outcome: "acknowledged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, rewritten, iso(20)));
    });

    it("changed: one of its two graphs was not upgraded, so the difference cannot be placed", async () => {
      const current = fingerprintInputs(REWRITTEN, graphs(["a2", 20], ["b1", null]));
      expect(await settle({ published: legacy, current })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("the same inputs under a mark it never recorded: adopted, so a later change regenerates", async () => {
      const marked = fingerprintInputs(ITEMS, graphs(["r1", 20]));
      expect(await settle({ published: legacy, current: marked })).toEqual({
        outcome: "unchanged",
      });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, marked, iso(20)));
      db.findAck.mockResolvedValue(ackRow(3, marked));
      expect(await settle({ published: legacy })).toEqual({ outcome: "changed" });
    });
  });

  describe("an acknowledgement left by an OLDER version is stale", () => {
    beforeEach(() => {
      db.findAck.mockResolvedValue(ackRow(2, rewritten));
    });

    it("its fingerprint is not a baseline for the new version", async () => {
      // Version 3 was generated against mark 20; the stale row says the same
      // inputs were acknowledged for version 2.
      const generatedAfter = fingerprintInputs(ITEMS, graphs(["r1", 20]));
      expect(await settle({ published: generatedAfter })).toEqual({ outcome: "changed" });
    });

    it("its marks are not what the new version has seen: the version's own manifest is", async () => {
      // The stale row recorded mark 20; version 3 was published before it.
      expect(await settle()).toEqual({ outcome: "acknowledged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, rewritten, iso(20)));
    });
  });

  it("changed: a document with no published version has nothing to tell an upgrade from", async () => {
    expect(await settle({ latest: null, published: null })).toEqual({ outcome: "changed" });
    // A version whose manifest recorded no snapshot.
    expect(await settle({ published: null })).toEqual({ outcome: "changed" });
    // No version, though a snapshot was handed in.
    expect(await settle({ latest: null })).toEqual({ outcome: "changed" });
    expect(db.findAck).not.toHaveBeenCalled();
    expect(db.upsertAck).not.toHaveBeenCalled();
  });
});
