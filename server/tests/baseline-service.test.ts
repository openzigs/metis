/**
 * Epic #609 / Issue #620 — baseline service pure helpers.
 *
 * Covers the version-pin substrate reuse (NO new snapshot machinery):
 * `snapshotAtVersion` replays `RequirementVersion.changedFields` diffs
 * backward from the current state, and `diffPinSets` classifies two
 * baselines' `(requirementId, version)` pin sets into added / removed /
 * changed / unchanged.
 */
import { describe, expect, it } from "vitest";
import type {
  RequirementSnapshot,
  VersionRow,
} from "../src/lib/requirements/requirement-version-service.js";
import { diffPinSets, snapshotAtVersion } from "../src/lib/reviews/baseline-service.js";

// ---- Fixtures -----------------------------------------------------------------

function snap(overrides: Partial<RequirementSnapshot> = {}): RequirementSnapshot {
  return {
    title: "Login must support SSO",
    body: "v3 body",
    priority: "high",
    type: "functional",
    labels: null,
    storyPoints: 5,
    reviewStatus: "approved",
    ...overrides,
  };
}

function versionRow(version: number, changedFields: Record<string, unknown>): VersionRow {
  return {
    version,
    changedFields: JSON.stringify(changedFields),
    actorId: "user-1",
    reason: null,
    createdAt: new Date("2026-07-01T00:00:00Z"),
  };
}

/**
 * History (newest first):
 *   v3: priority medium → high
 *   v2: title "Login" → "Login must support SSO", body "v1 body" → "v3 body"
 * v1 is the creation state (no version row until the first edit).
 */
const VERSIONS_DESC: VersionRow[] = [
  versionRow(3, { priority: { from: "medium", to: "high" } }),
  versionRow(2, {
    title: { from: "Login", to: "Login must support SSO" },
    body: { from: "v1 body", to: "v3 body" },
  }),
];

// ---- snapshotAtVersion ----------------------------------------------------------

describe("snapshotAtVersion", () => {
  it("returns the current state when pinned at the newest version", () => {
    expect(snapshotAtVersion(snap(), VERSIONS_DESC, 3)).toEqual(snap());
  });

  it("rolls back versions newer than the pin", () => {
    expect(snapshotAtVersion(snap(), VERSIONS_DESC, 2)).toEqual(snap({ priority: "medium" }));
  });

  it("reconstructs the creation state for a pin below every version row", () => {
    expect(snapshotAtVersion(snap(), VERSIONS_DESC, 1)).toEqual(
      snap({ priority: "medium", title: "Login", body: "v1 body" }),
    );
  });

  it("is unaffected by later edits (baseline immutability)", () => {
    // The requirement moved on to v4 AFTER the baseline pinned v2.
    const laterVersions = [
      versionRow(4, {
        storyPoints: { from: 5, to: 8 },
        reviewStatus: { from: "approved", to: "changes_requested" },
      }),
      ...VERSIONS_DESC,
    ];
    const currentV4 = snap({ storyPoints: 8, reviewStatus: "changes_requested" });
    expect(snapshotAtVersion(currentV4, laterVersions, 2)).toEqual(snap({ priority: "medium" }));
  });

  it("does not mutate the input snapshot", () => {
    const current = snap();
    snapshotAtVersion(current, VERSIONS_DESC, 1);
    expect(current).toEqual(snap());
  });

  it("tolerates malformed changedFields payloads", () => {
    const rows = [{ ...versionRow(2, {}), changedFields: "not-json{{" }];
    expect(snapshotAtVersion(snap(), rows, 1)).toEqual(snap());
  });
});

// ---- diffPinSets ----------------------------------------------------------------

describe("diffPinSets", () => {
  const pin = (requirementId: string, version: number) => ({ requirementId, version });

  it("classifies added, removed, changed, and unchanged pins", () => {
    const a = [pin("req-1", 2), pin("req-2", 1), pin("req-3", 4)];
    const b = [pin("req-1", 3), pin("req-3", 4), pin("req-4", 1)];

    const diff = diffPinSets(a, b);
    expect(diff.added).toEqual([pin("req-4", 1)]);
    expect(diff.removed).toEqual([pin("req-2", 1)]);
    expect(diff.changed).toEqual([{ requirementId: "req-1", fromVersion: 2, toVersion: 3 }]);
    expect(diff.unchanged).toEqual([pin("req-3", 4)]);
  });

  it("returns all-unchanged when comparing identical pin sets", () => {
    const pins = [pin("req-1", 1), pin("req-2", 2)];
    const diff = diffPinSets(pins, pins);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(2);
  });

  it("handles empty pin sets", () => {
    const diff = diffPinSets([], [pin("req-1", 1)]);
    expect(diff.added).toEqual([pin("req-1", 1)]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it("detects a version moving DOWN as changed (e.g. after a restore)", () => {
    const diff = diffPinSets([pin("req-1", 5)], [pin("req-1", 2)]);
    expect(diff.changed).toEqual([{ requirementId: "req-1", fromVersion: 5, toVersion: 2 }]);
  });

  it("sorts each bucket by requirementId for deterministic output", () => {
    const a = [pin("req-z", 1), pin("req-a", 1)];
    const diff = diffPinSets(a, []);
    expect(diff.removed.map((p) => p.requirementId)).toEqual(["req-a", "req-z"]);
  });
});
