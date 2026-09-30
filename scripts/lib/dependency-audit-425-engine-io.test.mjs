import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTopLevelOverrides,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for GHSA-2gc4-cqfq-p2gv (#425): Engine.IO protocol revision mismatch
 * DoS, CVSS 7.5, affected `>=6.6.0 <6.6.10`, published 2026-09-29 against an UNCHANGED
 * lockfile. The tree pinned engine.io to 6.6.7 through the exact override
 * `engine.io@6: 6.6.7`, so `Dependency audit` went red on every PR at once.
 *
 * engine.io is a transitive of socket.io, so the override is the pin. Both arms read the
 * lockfile — its `overrides:` block is what pnpm ACTUALLY applied (#1213) and its
 * `packages:` keys are what was resolved.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);

const FIXED = /** @type {[number, number, number]} */ ([6, 6, 10]);

describe("engine.io — GHSA-2gc4-cqfq-p2gv (#425)", () => {
  it("resolves NO engine.io copy below 6.6.10", () => {
    const resolved = resolvedLockfileVersions(lockfile, "engine.io");
    expect(resolved.length, "expected at least one engine.io copy in the tree").toBeGreaterThan(0);
    const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, FIXED));
    expect(breaching, `lockfile resolves engine.io ${breaching.join(", ")} below 6.6.10`).toEqual(
      [],
    );
  });

  it("the applied engine.io override targets 6.6.10 or above", () => {
    const entries = [...(effective?.entries() ?? [])].filter(([key]) =>
      key.startsWith("engine.io@"),
    );
    expect(entries.length, "no engine.io override in the lockfile's overrides block").toBe(1);
    const [key, target] = entries[0];
    const floor = /(\d+)\.(\d+)\.(\d+)/.exec(target);
    expect(floor, `override ${key}: "${target}" carries no version`).not.toBeNull();
    expect(
      resolvedVersionMeetsFloor(`${floor[1]}.${floor[2]}.${floor[3]}`, FIXED),
      `override ${key}: "${target}" is inside GHSA-2gc4-cqfq-p2gv (>=6.6.0 <6.6.10)`,
    ).toBe(true);
  });
});
