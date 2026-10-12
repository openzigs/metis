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
  findAck: vi.fn(),
  upsertAck: vi.fn(),
}));
vi.mock("../prisma.js", () => ({
  prisma: {
    codeGraph: { findMany: db.graphs },
    generatedDocumentAcknowledgement: { findUnique: db.findAck, upsert: db.upsertAck },
  },
}));

const {
  acknowledgeExtractorUpgrade,
  extractorUpgradeMark,
  isUnseenUpgradeMark,
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
/** The document's latest version is 3, published at second 10. */
const latest = { version: 3, createdAt: at(10) };
const settle = (args: Partial<Parameters<typeof settleExtractorUpgrade>[0]> = {}) =>
  settleExtractorUpgrade({
    documentId: "d",
    scope,
    latest,
    published,
    current: rewritten,
    ...args,
  });
const ackRow = (version: number, seconds: number, fingerprint: string) => ({
  documentId: "d",
  version,
  upgradedAt: at(seconds),
  fingerprint,
  updatedAt: at(seconds),
});
const upserted = (version: number, seconds: number, fingerprint: string) => ({
  where: { documentId: "d" },
  create: { documentId: "d", version, upgradedAt: at(seconds), fingerprint },
  update: { version, upgradedAt: at(seconds), fingerprint },
});

beforeEach(() => {
  vi.clearAllMocks();
  db.graphs.mockResolvedValue([{ extractorUpgradedAt: null }]);
  db.findAck.mockResolvedValue(null);
  db.upsertAck.mockResolvedValue({});
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

describe("isUnseenUpgradeMark", () => {
  it("needs a mark: a graph no upgrade ever rewrote gives no evidence", () => {
    expect(isUnseenUpgradeMark(null, at(10))).toBe(false);
  });

  it("needs the mark to be NEWER than what was already seen", () => {
    expect(isUnseenUpgradeMark(at(11), at(10))).toBe(true);
    expect(isUnseenUpgradeMark(new Date(at(10).getTime() + 1), at(10))).toBe(true);
    expect(isUnseenUpgradeMark(at(10), at(10))).toBe(false);
    expect(isUnseenUpgradeMark(at(9), at(10))).toBe(false);
  });
});

describe("acknowledgeExtractorUpgrade", () => {
  it("keeps one row per document: creates it, or replaces what an earlier version left", async () => {
    await acknowledgeExtractorUpgrade(
      { generatedDocumentAcknowledgement: { upsert: db.upsertAck } } as never,
      "d",
      4,
      { upgradedAt: at(20), fingerprint: "f" },
    );
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(4, 20, "f"));
  });
});

describe("settleExtractorUpgrade", () => {
  describe("a project no upgrade rewrote reads nothing more than before", () => {
    it("unchanged: the inputs are the published ones", async () => {
      expect(await settle({ current: published })).toEqual({ outcome: "unchanged" });
      expect(db.findAck).not.toHaveBeenCalled();
      expect(db.graphs).not.toHaveBeenCalled();
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: more than graph rows differ — neither the acknowledgement nor the graph is read", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      expect(await settle({ current: edited })).toEqual({ outcome: "changed" });
      expect(db.findAck).not.toHaveBeenCalled();
      expect(db.graphs).not.toHaveBeenCalled();
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: a graph-rows-only difference with NO mark on the graph", async () => {
      expect(await settle()).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });
  });

  it("changed: the mark is not newer than the version, which was generated after that upgrade", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(9) }]);
    expect(await settle()).toEqual({ outcome: "changed" });
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(10) }]);
    expect(await settle()).toEqual({ outcome: "changed" });
    expect(db.upsertAck).not.toHaveBeenCalled();
  });

  it("acknowledged: a newer mark and a graph-rows-only difference — recorded for the document's version", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
    expect(await settle()).toEqual({ outcome: "acknowledged" });
    expect(db.findAck).toHaveBeenCalledExactlyOnceWith({ where: { documentId: "d" } });
    expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, 20, rewritten.fingerprint));
  });

  describe("once acknowledged", () => {
    beforeEach(() => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
      db.findAck.mockResolvedValue(ackRow(3, 20, rewritten.fingerprint));
    });

    it("unchanged: the acknowledged inputs are a baseline too, and the graph is not read again", async () => {
      expect(await settle()).toEqual({ outcome: "unchanged" });
      expect(db.graphs).not.toHaveBeenCalled();
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("changed: the NEXT graph-rows-only difference, under the same mark, regenerates", async () => {
      expect(await settle({ current: rewrittenAgain })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });

    it("unchanged: back at the manifest's own inputs", async () => {
      expect(await settle({ current: published })).toEqual({ outcome: "unchanged" });
    });

    it("acknowledged again: a SECOND upgrade leaves a newer mark", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(30) }]);
      expect(await settle({ current: rewrittenAgain })).toEqual({ outcome: "acknowledged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(
        upserted(3, 30, rewrittenAgain.fingerprint),
      );
    });

    it("changed: a second upgrade together with a source change", async () => {
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(30) }]);
      expect(await settle({ current: edited })).toEqual({ outcome: "changed" });
      expect(db.upsertAck).not.toHaveBeenCalled();
    });
  });

  describe("an acknowledgement left by an OLDER version is stale", () => {
    beforeEach(() => {
      // Version 2 was acknowledged at second 5; version 3 was published at second 10.
      db.findAck.mockResolvedValue(ackRow(2, 5, rewritten.fingerprint));
    });

    it("its fingerprint is not a baseline for the new version", async () => {
      expect(await settle()).toEqual({ outcome: "changed" });
    });

    it("its mark is not what the new version has seen: the version's own date is", async () => {
      // An upgrade between the stale acknowledgement and the version: already seen.
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(8) }]);
      expect(await settle()).toEqual({ outcome: "changed" });
      // One after the version: new.
      db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(12) }]);
      expect(await settle()).toEqual({ outcome: "acknowledged" });
      expect(db.upsertAck).toHaveBeenCalledExactlyOnceWith(upserted(3, 12, rewritten.fingerprint));
    });
  });

  it("changed: a document with no published version has nothing to tell an upgrade from", async () => {
    db.graphs.mockResolvedValue([{ extractorUpgradedAt: at(20) }]);
    expect(await settle({ latest: null, published: null })).toEqual({ outcome: "changed" });
    // A version whose manifest recorded no snapshot.
    expect(await settle({ published: null })).toEqual({ outcome: "changed" });
    expect(db.findAck).not.toHaveBeenCalled();
    expect(db.upsertAck).not.toHaveBeenCalled();
  });
});
