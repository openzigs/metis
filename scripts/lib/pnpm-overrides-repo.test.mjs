import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  auditOverrides,
  ENGINES_PNPM_FLOOR,
  findWorkspaceManifests,
  parseTopLevelOverrides,
  rangeMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * The live guard (#1213): are THIS repo's ~26 security overrides declared where pnpm
 * reads them, and did pnpm actually apply them?
 *
 * `pnpm-overrides-core.test.mjs` proves the audit fails on each way that can go wrong.
 * This file points it at the real tree.
 *
 * The floor exists because zero-overrides-everywhere is internally consistent and would
 * satisfy every diff — the "default that means nothing to check" shape that produced
 * #1168. The repo carries 26; 20 leaves room to retire a few advisories without editing
 * a test, while a wholesale collapse still goes red.
 */
const MINIMUM_OVERRIDES = 20;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (name) => readFileSync(resolve(REPO_ROOT, name), "utf8");

const { manifests, missing } = findWorkspaceManifests(REPO_ROOT, read("pnpm-workspace.yaml"));

const result = auditOverrides({
  manifests,
  workspaceText: read("pnpm-workspace.yaml"),
  lockfileText: read("pnpm-lock.yaml"),
  minimumOverrides: MINIMUM_OVERRIDES,
});

describe("pnpm overrides are declared where pnpm reads them, and were applied", () => {
  it("reports no problems", () => {
    expect(
      result.problems.map((p) => `[${p.kind}] ${p.message}`),
      "override configuration is not in the state pnpm actually honours",
    ).toEqual([]);
  });

  it("finds every declared override applied in the lockfile", () => {
    expect(result.declared).not.toBeNull();
    expect(result.effective).not.toBeNull();
    expect([...result.effective.keys()].sort()).toEqual([...result.declared.keys()].sort());
    expect(result.declared.size).toBeGreaterThanOrEqual(MINIMUM_OVERRIDES);
  });

  // The identity assertion, stated on its own so a failure names the cause directly:
  // no manifest anywhere may reintroduce the field pnpm 11 ignores.
  it("has no `pnpm` field in any workspace package.json", () => {
    const offenders = manifests
      .filter((m) => {
        try {
          return typeof JSON.parse(m.text).pnpm === "object";
        } catch {
          return true; // unreadable is a failure, not a skip
        }
      })
      .map((m) => m.path);
    expect(
      offenders,
      'pnpm 11 ignores the "pnpm" field of package.json with a WARNING and exit 0; ' +
        "these settings belong in pnpm-workspace.yaml (#1213)",
    ).toEqual([]);
  });

  // Guards the migration itself: `onlyBuiltDependencies` shared the `pnpm` field with
  // the overrides and pnpm 11 drops it in the same breath, which would silently stop
  // the native builds (better-sqlite3, prisma, sharp, tree-sitter) from running.
  it("keeps onlyBuiltDependencies in pnpm-workspace.yaml", () => {
    expect(read("pnpm-workspace.yaml")).toMatch(/^onlyBuiltDependencies:/m);
  });

  it("declares the overrides as a top-level key of pnpm-workspace.yaml", () => {
    expect(parseTopLevelOverrides(read("pnpm-workspace.yaml"))).not.toBeNull();
  });

  // The domain is derived from `packages:`, so a typo there would shrink what gets
  // audited. A declared package with no manifest is reported, never skipped.
  it("resolves a manifest for every declared workspace package", () => {
    expect(missing, "a `packages:` entry has no package.json").toEqual([]);
    expect(manifests.length).toBeGreaterThanOrEqual(8);
  });
});

/**
 * The version floor the migration created a need for.
 *
 * Moving the overrides into `pnpm-workspace.yaml` makes them invisible to every pnpm
 * before 10.5.1 — silently, exit 0, no warning (the table on `WORKSPACE_OVERRIDES_FLOOR`
 * has the measurements). `engines.pnpm` was `">=9.0.0"`, which admitted that whole band,
 * so the migration would have reintroduced from below the exact failure #1213 exists to
 * prevent.
 *
 * **This assertion is not itself the enforcement, and does not need to be.** pnpm reads
 * `engines.pnpm` and refuses to install below it — `ERR_PNPM_UNSUPPORTED_ENGINE`, exit 1,
 * measured, and not disableable via `engine-strict` (see the note at the foot of
 * `pnpm-overrides-core.mjs`). The field is the gate. What a test can add is protection
 * against the field being *lowered* again, silently, in some future PR — which is exactly
 * how `">=9.0.0"` came to be sitting under a migration that needed 10.16.0.
 */
describe("the pnpm floor that keeps pnpm-workspace.yaml readable", () => {
  it("pins engines.pnpm at or above the floor the whole file needs", () => {
    const engines = JSON.parse(read("package.json")).engines ?? {};
    const floor = ENGINES_PNPM_FLOOR.join(".");
    expect(engines.pnpm, "package.json declares no engines.pnpm").toBeTypeOf("string");
    expect(
      rangeMeetsFloor(engines.pnpm, ENGINES_PNPM_FLOOR),
      `engines.pnpm is "${engines.pnpm}", which permits a pnpm older than ${floor}. ` +
        `pnpm-workspace.yaml needs 10.5.1 for \`overrides:\` (below that the whole block is ` +
        `ignored with no warning, exit 0) and 10.16.0 for #586's \`minimumReleaseAge\` ` +
        `(below that the seven-day quarantine silently does nothing). The floor is the ` +
        `highest requirement in the file, not the lowest (#1213).`,
    ).toBe(true);
  });

  // The floor is only meaningful if the key it protects is actually still there.
  it("still declares the minimumReleaseAge that sets the 10.16.0 requirement", () => {
    expect(
      read("pnpm-workspace.yaml"),
      "minimumReleaseAge is gone, so ENGINES_PNPM_FLOOR's rationale no longer holds — " +
        "re-derive the floor rather than leaving it at a version nothing justifies",
    ).toMatch(/^minimumReleaseAge:\s*\d+/m);
  });
});
