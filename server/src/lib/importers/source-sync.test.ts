/**
 * Issue #1220 — the re-sync three-way decision, case by case.
 */
import { describe, expect, it } from "vitest";
import {
  decideResync,
  parseSourceDecision,
  parseSourcePending,
  editedInMetisFromHistory,
  sourceFingerprint,
  toSourceDivergence,
  type SourceContent,
  type SourcePending,
} from "./source-sync.js";

const NOW = new Date("2026-10-16T10:00:00.000Z");

const original: SourceContent = {
  title: "Export orders",
  body: "As imported",
  type: "feature",
  priority: "medium",
  labels: ["export"],
};
const analystEdit: SourceContent = { ...original, body: "Refined by the analyst" };
const upstream: SourceContent = { ...original, title: "Export orders as CSV" };

const fp = sourceFingerprint;

describe("sourceFingerprint", () => {
  it("is stable, versioned, and ignores label order, duplicates and hidden labels", () => {
    expect(fp(original)).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(fp(original)).toBe(fp({ ...original }));
    expect(fp({ ...original, labels: ["b", "a"] })).toBe(
      fp({ ...original, labels: ["a", "b", "a"] }),
    );
    expect(fp({ ...original, labels: ["export", "finding:f1", "review:approved"] })).toBe(
      fp(original),
    );
  });

  it("changes with each owned field", () => {
    for (const change of [
      { title: "x" },
      { body: "x" },
      { type: "bug" },
      { priority: "high" },
      { labels: ["other"] },
    ]) {
      expect(fp({ ...original, ...change })).not.toBe(fp(original));
    }
  });
});

describe("decideResync", () => {
  it("source unchanged, local not edited: unchanged, nothing written", () => {
    const d = decideResync({
      local: original,
      stored: fp(original),
      pending: null,
      source: original,
      now: NOW,
    });
    expect(d).toEqual({ outcome: "unchanged", fingerprint: fp(original), write: null });
  });

  it("source unchanged, local edited: keeps the local edit, nothing written", () => {
    const d = decideResync({
      local: analystEdit,
      stored: fp(original),
      pending: null,
      source: original,
      now: NOW,
    });
    expect(d).toEqual({ outcome: "kept_local", fingerprint: fp(original), write: null });
  });

  it("source changed, local not edited: applies the source", () => {
    const d = decideResync({
      local: original,
      stored: fp(original),
      pending: null,
      source: upstream,
      now: NOW,
    });
    expect(d).toEqual({ outcome: "apply_source", fingerprint: fp(upstream), write: null });
  });

  it("both changed: diverged, keeps the local copy and records the source", () => {
    const d = decideResync({
      local: analystEdit,
      stored: fp(original),
      pending: null,
      source: upstream,
      now: NOW,
    });
    expect(d.outcome).toBe("diverged");
    expect(d.write).toEqual({
      sourcePending: { ...upstream, fingerprint: fp(upstream), detectedAt: NOW.toISOString() },
    });
    expect(d.write).not.toHaveProperty("sourceFingerprint");
  });

  it("an already-diverged row seeing the same source writes nothing (detectedAt stands)", () => {
    const pending: SourcePending = {
      ...upstream,
      fingerprint: fp(upstream),
      detectedAt: "earlier",
    };
    const d = decideResync({
      local: analystEdit,
      stored: fp(original),
      pending,
      source: upstream,
      now: NOW,
    });
    expect(d).toEqual({ outcome: "diverged", fingerprint: fp(upstream), write: null });
  });

  it("a diverged row whose source moves again records the newer source", () => {
    const pending: SourcePending = {
      ...upstream,
      fingerprint: fp(upstream),
      detectedAt: "earlier",
    };
    const newer = { ...upstream, body: "Changed again" };
    const d = decideResync({
      local: analystEdit,
      stored: fp(original),
      pending,
      source: newer,
      now: NOW,
    });
    expect(d.outcome).toBe("diverged");
    expect(d.write?.sourcePending).toMatchObject({ body: "Changed again", fingerprint: fp(newer) });
  });

  it("a diverged row whose source reverts to the last synced content is no longer diverged", () => {
    const pending: SourcePending = {
      ...upstream,
      fingerprint: fp(upstream),
      detectedAt: "earlier",
    };
    const d = decideResync({
      local: analystEdit,
      stored: fp(original),
      pending,
      source: original,
      now: NOW,
    });
    expect(d).toEqual({
      outcome: "kept_local",
      fingerprint: fp(original),
      write: { sourcePending: null },
    });
  });

  it("local and source changed to the same content: records the fingerprint, no divergence", () => {
    const pending: SourcePending = {
      ...upstream,
      fingerprint: fp(upstream),
      detectedAt: "earlier",
    };
    const d = decideResync({
      local: upstream,
      stored: fp(original),
      pending,
      source: upstream,
      now: NOW,
    });
    expect(d).toEqual({
      outcome: "unchanged",
      fingerprint: fp(upstream),
      write: { sourceFingerprint: fp(upstream), sourcePending: null },
    });
  });

  describe("rows synced before the fingerprint existed", () => {
    it("equal to the source: records the fingerprint and does nothing else", () => {
      const d = decideResync({
        local: original,
        stored: null,
        pending: null,
        source: original,
        now: NOW,
      });
      expect(d).toEqual({
        outcome: "unchanged",
        fingerprint: fp(original),
        write: { sourceFingerprint: fp(original), sourcePending: null },
      });
    });

    it("different from the source and edited by a person: diverged, baseline unknown", () => {
      const d = decideResync({
        local: analystEdit,
        stored: null,
        pending: null,
        source: original,
        now: NOW,
        editedInMetis: true,
      });
      expect(d.outcome).toBe("diverged");
      expect(d.write).toEqual({
        sourcePending: {
          ...original,
          fingerprint: fp(original),
          detectedAt: NOW.toISOString(),
          baselineUnknown: true,
        },
      });
    });

    it("different from the source but never edited by a person: applies the source", () => {
      for (const editedInMetis of [false, undefined]) {
        const d = decideResync({
          local: original,
          stored: null,
          pending: null,
          source: upstream,
          now: NOW,
          editedInMetis,
        });
        expect(d).toEqual({ outcome: "apply_source", fingerprint: fp(upstream), write: null });
      }
    });

    it("the History evidence is ignored once a fingerprint is stored", () => {
      const d = decideResync({
        local: original,
        stored: fp(original),
        pending: null,
        source: upstream,
        now: NOW,
        editedInMetis: true,
      });
      expect(d.outcome).toBe("apply_source");
    });
  });
});

describe("parseSourcePending / parseSourceDecision", () => {
  it("round-trips well-formed values", () => {
    const pending: SourcePending = { ...upstream, fingerprint: "v1:x", detectedAt: "t" };
    expect(parseSourcePending(JSON.stringify(pending))).toEqual(pending);
    const unknown: SourcePending = { ...pending, baselineUnknown: true };
    expect(parseSourcePending(JSON.stringify(unknown))).toEqual(unknown);
    expect(toSourceDivergence(JSON.stringify(unknown))).toMatchObject({ baselineUnknown: true });
    expect(toSourceDivergence(JSON.stringify(pending))).not.toHaveProperty("baselineUnknown");
    const decision = { choice: "local" as const, fingerprint: "v1:x", actorId: "u1", at: "t" };
    expect(parseSourceDecision(JSON.stringify(decision))).toEqual(decision);
    expect(parseSourceDecision(JSON.stringify({ ...decision, actorId: null }))).toMatchObject({
      actorId: null,
    });
  });

  it("reads null, malformed and wrongly shaped values as nothing", () => {
    for (const raw of [null, undefined, "", "{", "[]", JSON.stringify({ title: "x" })]) {
      expect(parseSourcePending(raw)).toBeNull();
      expect(parseSourceDecision(raw)).toBeNull();
    }
    expect(
      parseSourceDecision(
        JSON.stringify({ choice: "both", fingerprint: "x", actorId: null, at: "t" }),
      ),
    ).toBeNull();
    expect(
      parseSourcePending(
        JSON.stringify({ ...upstream, labels: [1], fingerprint: "x", detectedAt: "t" }),
      ),
    ).toBeNull();
  });
});

describe("editedInMetisFromHistory", () => {
  const IMPORT = "Import re-sync";
  const row = (version: number, fields: string[], reason: string | null) => ({
    version,
    changedFields: Object.fromEntries(fields.map((f) => [f, { from: "a", to: "b" }])),
    reason,
  });

  it("never edited: no rows, no bump", () => {
    expect(editedInMetisFromHistory(0, [], IMPORT)).toBe(false);
  });

  it("the newest source-owned change decides, whoever the actor", () => {
    expect(editedInMetisFromHistory(1, [row(1, ["body"], null)], IMPORT)).toBe(true);
    expect(editedInMetisFromHistory(1, [row(1, ["body"], "Clarification answers")], IMPORT)).toBe(
      true,
    );
    // An analyst edit a later re-sync reverted: the re-sync is newest.
    expect(
      editedInMetisFromHistory(2, [row(2, ["body"], IMPORT), row(1, ["body"], null)], IMPORT),
    ).toBe(false);
    // ...and the reverse order: an edit after a re-sync counts.
    expect(
      editedInMetisFromHistory(2, [row(1, ["body"], IMPORT), row(2, ["title"], null)], IMPORT),
    ).toBe(true);
  });

  it("changes to fields the source does not own are ignored", () => {
    expect(
      editedInMetisFromHistory(1, [row(1, ["storyPoints", "acceptanceCriteria"], null)], IMPORT),
    ).toBe(false);
  });

  it("keeps #1162's legacy rule: a bump with no row for version 1", () => {
    expect(editedInMetisFromHistory(2, [], IMPORT)).toBe(true);
    expect(editedInMetisFromHistory(3, [row(3, ["storyPoints"], null)], IMPORT)).toBe(true);
  });
});
