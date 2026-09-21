import { describe, expect, it } from "vitest";

import {
  DOC_SNAPSHOT_PREFIX,
  formatRestoreReport,
  isSatisfied,
  planSnapshotRestore,
} from "./corpus-snapshot-restore-core.mjs";

/**
 * Unit tests for #1382's snapshot-restore decision core.
 *
 * The property under test is narrow and load-bearing: untracking a directory that a
 * test suite reads is only safe if "put it back" and "do not touch it" are decided
 * from the committed manifest rather than from whether a read happened to throw.
 */

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

/** @param {Record<string, { sha256: string, source: string | null }>} files */
const manifestOf = (files) => ({ files });

/** @param {Record<string, string | null>} disk */
const hasher = (disk) => (rel) => (rel in disk ? disk[rel] : null);

describe("planSnapshotRestore", () => {
  it("restores a file that is absent", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({}),
    });

    expect(plan.restore).toEqual([{ rel: "docs/A.md", source: "docs/A.md", sha256: HASH_A }]);
    expect(plan.upToDate).toEqual([]);
    expect(isSatisfied(plan)).toBe(false);
  });

  it("leaves a file that already matches, and reports nothing to do", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({ "docs/A.md": HASH_A }),
    });

    expect(plan.restore).toEqual([]);
    expect(plan.upToDate).toEqual(["docs/A.md"]);
    expect(isSatisfied(plan)).toBe(true);
  });

  it("does NOT overwrite a file that is present but drifted", () => {
    // Absent and drifted are different questions. Restoring over a drifted file
    // erases the evidence that someone edited a frozen corpus, which is the one
    // thing the snapshot manifest exists to catch.
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({ "docs/A.md": HASH_B }),
    });

    expect(plan.restore).toEqual([]);
    expect(plan.drifted).toEqual([{ rel: "docs/A.md", expected: HASH_A, actual: HASH_B }]);
    expect(isSatisfied(plan)).toBe(false);
  });

  it("overwrites a drifted file only when the caller asks for a resync", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({ "docs/A.md": HASH_B }),
      resyncDrifted: true,
    });

    expect(plan.restore).toEqual([{ rel: "docs/A.md", source: "docs/A.md", sha256: HASH_A }]);
    expect(plan.drifted).toEqual([]);
  });

  it("calls an absent entry with no source UNRESTORABLE rather than skipping it", () => {
    // `source: null` means "no provenance claim" — there is nothing in history to
    // rebuild from. Treating that as "nothing to do" would let a corpus run with a
    // file missing, and every measurement would then be over a different corpus.
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/EXCERPT.md": { sha256: HASH_A, source: null } }),
      hashOf: hasher({}),
    });

    expect(plan.restore).toEqual([]);
    expect(plan.unrestorable).toEqual([
      { rel: "docs/EXCERPT.md", reason: expect.stringContaining("no `source`") },
    ]);
    expect(isSatisfied(plan)).toBe(false);
  });

  it("reports a PRESENT sourceless entry as drifted, not unrestorable", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/EXCERPT.md": { sha256: HASH_A, source: null } }),
      hashOf: hasher({ "docs/EXCERPT.md": HASH_C }),
    });

    expect(plan.unrestorable).toEqual([]);
    expect(plan.drifted).toEqual([{ rel: "docs/EXCERPT.md", expected: HASH_A, actual: HASH_C }]);
  });

  it("ignores manifest entries outside the docs/ subtree", () => {
    // `repo/` and `schema/` are the NL→code corpora's snapshots and are still
    // TRACKED; restoring them would fight git for ownership of the same bytes.
    const plan = planSnapshotRestore({
      manifest: manifestOf({
        "repo/auth/jwt.ts": { sha256: HASH_A, source: "server/src/lib/auth/jwt.ts" },
        "schema/schema.prisma": { sha256: HASH_B, source: null },
      }),
      hashOf: hasher({}),
    });

    expect(plan).toEqual({ restore: [], upToDate: [], drifted: [], unrestorable: [] });
    expect(isSatisfied(plan)).toBe(true);
  });

  it("honours a caller-supplied prefix", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "repo/a.ts": { sha256: HASH_A, source: "src/a.ts" } }),
      hashOf: hasher({}),
      prefix: "repo/",
    });

    expect(plan.restore).toHaveLength(1);
    expect(DOC_SNAPSHOT_PREFIX).toBe("docs/");
  });

  it("tolerates a manifest with no files map", () => {
    const plan = planSnapshotRestore({ manifest: {}, hashOf: hasher({}) });

    expect(isSatisfied(plan)).toBe(true);
  });
});

describe("formatRestoreReport", () => {
  const base = {
    corpusId: "docretrieval-01-metis-docs",
    snapshotCommit: "953bfe70".padEnd(40, "0"),
  };

  it("names the commit and the count when files were written", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({}),
    });

    const report = formatRestoreReport({ ...base, plan, written: ["docs/A.md"] }).join("\n");

    expect(report).toContain("restored 1 snapshot file(s) from 953bfe70");
  });

  it("says what drifted and does not pretend it was fixed", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({ "docs/A.md": HASH_B }),
    });

    const report = formatRestoreReport({ ...base, plan }).join("\n");

    expect(report).toContain("DRIFTED  docs/A.md");
    expect(report).toContain("Nothing was overwritten");
    expect(report).toContain("--resync");
    expect(report).not.toContain("restored");
  });

  it("names an unrestorable file and why", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/E.md": { sha256: HASH_A, source: null } }),
      hashOf: hasher({}),
    });

    const report = formatRestoreReport({ ...base, plan }).join("\n");

    expect(report).toContain("MISSING  docs/E.md");
    expect(report).toContain("cannot be rebuilt from history");
  });

  it("reports the already-matching count when there is nothing to do", () => {
    const plan = planSnapshotRestore({
      manifest: manifestOf({ "docs/A.md": { sha256: HASH_A, source: "docs/A.md" } }),
      hashOf: hasher({ "docs/A.md": HASH_A }),
    });

    expect(formatRestoreReport({ ...base, plan }).join("\n")).toContain(
      "1 snapshot file(s) already match",
    );
  });
});
