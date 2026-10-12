/**
 * #1071 (PR #1104, review cycle 2 and all three lenses of the second panel) —
 * when a difference in a document's inputs may be put down to a code-graph
 * extractor upgrade.
 *
 * The rule this replaces inferred the upgrade from an OLD record lacking a
 * field newer ones carry. That is true of every record written before the
 * field existed, for ever, so it suppressed every later change confined to
 * graph rows in every project. The cases below pin the two things that make
 * the rule narrow: positive evidence that an upgrade rewrote THIS graph (a
 * mark the upgrading ingest leaves), and acknowledging it exactly once.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintInputs } from "./regeneration-plan.js";

const db = vi.hoisted(() => ({
  graphs: vi.fn(),
  updateVersion: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findMany: db.graphs },
    generatedDocumentVersion: { updateMany: db.updateVersion },
  },
}));

const {
  extractorUpgradeMark,
  isUnseenExtractorUpgrade,
  parseAcknowledgedInputs,
  serializeAcknowledgedInputs,
  settleExtractorUpgrade,
} = await import("./extractor-upgrade.js");

const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
const published = fingerprintInputs({
  "symbol:a": "1",
  "edge:b": "1",
  "source:c": "1",
  settings: "s",
});
/** Graph rows rewritten, nothing else. */
const rewritten = fingerprintInputs({
  "symbol:z": "1",
  "edge:b": "2",
  "source:c": "1",
  settings: "s",
});
/** Graph rows rewritten again. */
const rewrittenAgain = fingerprintInputs({
  "symbol:z": "1",
  "edge:b": "3",
  "source:c": "1",
  settings: "s",
});
/** Graph rows rewritten AND a source file changed. */
const edited = fingerprintInputs({
  "symbol:z": "1",
  "edge:b": "2",
  "source:c": "2",
  settings: "s",
});
const scope = { projectId: "p", codeGraphId: "g" };
const version = (extra: { acknowledgedInputs?: string | null } = {}) => ({
  version: 3,
  createdAt: at(10),
  acknowledgedInputs: null,
  ...extra,
});
const settle = (args: Partial<Parameters<typeof settleExtractorUpgrade>[0]>) =>
  settleExtractorUpgrade({
    documentId: "d",
    scope,
    latest: version(),
    published,
    current: rewritten,
    ...args,
  });

beforeEach(() => {
  vi.clearAllMocks();
  db.graphs.mockResolvedValue([{ extractorUpgradedAt: null }]);
  db.updateVersion.mockResolvedValue({ count: 1 });
});

describe("extractorUpgradeMark", () => {
  it("is null when no graph in scope was ever rewritten by an upgrade", async () => {
    expect(await extractorUpgradeMark(scope)).toBeNull();
    db.graphs.mockResolvedValue([]);
    expect(await extractorUpgradeMark(scope)).toBeNull();
    // A graph row read before the column existed.
    db.graphs.mockResolvedValue([{}]);
    expect(await extractorUpgradeMark(scope)).toBeNull();
  });

  it("is the LATEST mark of the graphs in scope", async () => {
    db.graphs.mockResolvedValue([
      { extractorUpgradedAt: at(20) },
      { extractorUpgradedAt: null },
      { extractorUpgradedAt: at(40) },
      { extractorUpgradedAt: at(30) },
    ]);
    expect(await extractorUpgradeMark(scope)).toEqual(at(40));
  });

  it("reads the graphs the document reads: the project's, or the one it is scoped to", async () => {
    await extractorUpgradeMark({ projectId: "p", codeGraphId: "g" });
    expect(db.graphs).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { projectId: "p", id: "g" } }),
    );
    await extractorUpgradeMark({ projectId: "p" });
    expect(db.graphs).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { projectId: "p" } }),
    );
    await extractorUpgradeMark({ projectId: "p", codeGraphId: null });
    expect(db.graphs).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: { projectId: "p" } }),
    );
  });
});

describe("isUnseenExtractorUpgrade", () => {
  it("needs a mark: without one a graph-rows-only difference is a real change", () => {
    expect(isUnseenExtractorUpgrade(published, rewritten, null, at(10))).toBe(false);
    expect(isUnseenExtractorUpgrade(published, rewritten, null, null)).toBe(false);
  });

  it("needs the mark to be NEWER than what was already seen", () => {
    expect(isUnseenExtractorUpgrade(published, rewritten, at(11), at(10))).toBe(true);
    expect(isUnseenExtractorUpgrade(published, rewritten, at(10), at(10))).toBe(false);
    expect(isUnseenExtractorUpgrade(published, rewritten, at(9), at(10))).toBe(false);
    // Nothing seen yet: any mark is new.
    expect(isUnseenExtractorUpgrade(published, rewritten, at(1), null)).toBe(true);
  });

  it("needs the difference to be confined to graph rows", () => {
    expect(isUnseenExtractorUpgrade(published, edited, at(11), at(10))).toBe(false);
    expect(isUnseenExtractorUpgrade(published, published, at(11), at(10))).toBe(false);
    expect(isUnseenExtractorUpgrade(null, rewritten, at(11), at(10))).toBe(false);
  });
});

describe("acknowledged inputs", () => {
  it("round-trips", () => {
    const stored = serializeAcknowledgedInputs({ upgradedAt: at(20), snapshot: rewritten });
    expect(parseAcknowledgedInputs(stored)).toEqual({ upgradedAt: at(20), snapshot: rewritten });
  });

  it.each([
    ["absent", null],
    ["undefined", undefined],
    ["empty", ""],
    ["not JSON", "{oops"],
    ["a JSON scalar", "7"],
    ["no snapshot", JSON.stringify({ upgradedAt: at(20).toISOString() })],
    ["no mark", JSON.stringify({ snapshot: rewritten })],
    ["a mark that is no date", JSON.stringify({ upgradedAt: "soon", snapshot: rewritten })],
    [
      "a malformed snapshot",
      JSON.stringify({ upgradedAt: at(20).toISOString(), snapshot: { items: {} } }),
    ],
    [
      "an unknown field",
      JSON.stringify({ upgradedAt: at(20).toISOString(), snapshot: rewritten, extra: 1 }),
    ],
  ])("reads %s as nothing acknowledged", (_label, stored) => {
    expect(parseAcknowledgedInputs(stored)).toBeNull();
  });
});

describe("settleExtractorUpgrade", () => {
  it("unchanged: the inputs are the published ones — no graph is even read", async () => {
    expect(await settle({ current: published })).toEqual({ outcome: "unchanged" });
    expect(db.graphs).not.toHaveBeenCalled();
    expect(db.updateVersion).not.toHaveBeenCalled();
  });

  it("changed: a graph-rows-only difference with NO mark — every project no upgrade rewrote", async () => {
    expect(await settle({})).toEqual({ outcome: "changed" });
    expect(db.updateVersion).not.toHaveBeenCalled();
  });

  it("changed: the mark is older than the version, which was generated after that upgrade", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(9) }]);
    expect(await settle({})).toEqual({ outcome: "changed" });
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(10) }]);
    expect(await settle({})).toEqual({ outcome: "changed" });
    expect(db.updateVersion).not.toHaveBeenCalled();
  });

  it("acknowledged: a newer mark and a graph-rows-only difference — recorded beside the version", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
    expect(await settle({})).toEqual({ outcome: "acknowledged" });
    expect(db.updateVersion).toHaveBeenCalledExactlyOnceWith({
      where: { documentId: "d", version: 3 },
      data: {
        acknowledgedInputs: serializeAcknowledgedInputs({
          upgradedAt: at(20),
          snapshot: rewritten,
        }),
      },
    });
  });

  it("changed: a newer mark, but more than graph rows differ", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
    expect(await settle({ current: edited })).toEqual({ outcome: "changed" });
    // The mark is not even needed to know that.
    expect(db.graphs).not.toHaveBeenCalled();
    expect(db.updateVersion).not.toHaveBeenCalled();
  });

  describe("once acknowledged", () => {
    const acknowledged = version({
      acknowledgedInputs: serializeAcknowledgedInputs({ upgradedAt: at(20), snapshot: rewritten }),
    });

    it("unchanged: the acknowledged inputs are the baseline now, not the manifest's", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      expect(await settle({ latest: acknowledged })).toEqual({ outcome: "unchanged" });
      expect(db.updateVersion).not.toHaveBeenCalled();
    });

    it("changed: the NEXT graph-rows-only difference, under the same mark, regenerates", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      expect(await settle({ latest: acknowledged, current: rewrittenAgain })).toEqual({
        outcome: "changed",
      });
      expect(db.updateVersion).not.toHaveBeenCalled();
    });

    it("changed: going back to the manifest's inputs is a change too", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      expect(await settle({ latest: acknowledged, current: published })).toEqual({
        outcome: "changed",
      });
    });

    it("acknowledged again: a SECOND upgrade leaves a newer mark", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(30) }]);
      expect(await settle({ latest: acknowledged, current: rewrittenAgain })).toEqual({
        outcome: "acknowledged",
      });
      expect(db.updateVersion).toHaveBeenCalledExactlyOnceWith({
        where: { documentId: "d", version: 3 },
        data: {
          acknowledgedInputs: serializeAcknowledgedInputs({
            upgradedAt: at(30),
            snapshot: rewrittenAgain,
          }),
        },
      });
    });

    it("an unreadable acknowledgement falls back to the manifest", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      const corrupt = version({ acknowledgedInputs: "{oops" });
      expect(await settle({ latest: corrupt, current: published })).toEqual({
        outcome: "unchanged",
      });
      expect(await settle({ latest: corrupt })).toEqual({ outcome: "acknowledged" });
    });
  });

  it("changed: a document with no published version has nothing to tell an upgrade from", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
    expect(await settle({ latest: null, published: null })).toEqual({ outcome: "changed" });
    // A version whose manifest recorded no snapshot.
    expect(await settle({ published: null })).toEqual({ outcome: "changed" });
    expect(db.updateVersion).not.toHaveBeenCalled();
  });
});
