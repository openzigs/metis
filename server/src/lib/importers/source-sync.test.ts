/**
 * Issue #1220 — the re-sync three-way decision, case by case.
 */
import { describe, expect, it } from "vitest";
import {
  decideResync,
  parseSourceDecision,
  parseSourcePending,
  sourceFingerprint,
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

    it("different from the source: diverged (source unknown), never overwritten", () => {
      const d = decideResync({
        local: analystEdit,
        stored: null,
        pending: null,
        source: original,
        now: NOW,
      });
      expect(d.outcome).toBe("diverged");
      expect(d.write).toEqual({
        sourcePending: { ...original, fingerprint: fp(original), detectedAt: NOW.toISOString() },
      });
    });
  });
});

describe("parseSourcePending / parseSourceDecision", () => {
  it("round-trips well-formed values", () => {
    const pending: SourcePending = { ...upstream, fingerprint: "v1:x", detectedAt: "t" };
    expect(parseSourcePending(JSON.stringify(pending))).toEqual(pending);
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
