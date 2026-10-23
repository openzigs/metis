import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTopLevelOverrides,
  rangeMeetsFloor,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for zod GHSA-mrhx-c7xc-m3w5 (#1453): HIGH, "Zod can exhaust memory
 * while validating oversized constrained collections", `introduced 0, fixed 4.6.6`. It
 * turned `Dependency audit` red on every PR on 2026-10-23.
 *
 * The tree carries two zod lines, closed two different ways:
 *
 *   - zod 4 (server, packages/shared, @anthropic-ai/sdk, @modelcontextprotocol/sdk) is
 *     UPGRADED: manifest floor ^4.6.6 plus an override bounded at the fix.
 *   - zod@3.25.76 (botbuilder* 4.23.3, chromium-bidi) has no patched 3.x, and botbuilder
 *     cannot load on zod 4, so it is WAIVED in sast.yml — scoped to that exact copy, so the
 *     waiver can never mute a regression on the 4.x line.
 *
 * Same shape as the #1420 guard: every arm reads the resolved lockfile, the declaring
 * manifest or the gate's own waiver dict, never an override string alone.
 */

const FIXED = /** @type {const} */ ([4, 6, 6]);
const FLOOR = FIXED.join(".");
const ADVISORY = "GHSA-mrhx-c7xc-m3w5";
/** The one copy the waiver may cover. Moving it is a decision, not a lockfile refresh. */
const WAIVED_COPY = "zod@3.25.76";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);
const workflowText = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "sast.yml"), "utf8");

const PYTHON3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/**
 * @param {string} manifestPath repo-relative
 * @returns {string | undefined}
 */
function declaredZod(manifestPath) {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestPath), "utf8"));
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    const range = manifest[block]?.zod;
    if (range) return range;
  }
  return undefined;
}

/**
 * The live waiver for the advisory, read the way the gate reads it. The dict is executed
 * in python3 when available (a comment cannot desynchronise it); otherwise the entry is
 * sliced from the located block. Either way, "not found" fails instead of reading as
 * "no waiver".
 *
 * @returns {{ expires: string, packages?: string[], reason: string } | undefined}
 */
function liveWaiver() {
  const lines = workflowText.split("\n");
  const start = lines.findIndex((line) => line.trim() === "python3 - <<'PY'");
  const end = lines.findIndex((line, i) => i > start && line.trim() === "PY");
  expect(start, "sast.yml no longer contains the threshold heredoc").toBeGreaterThan(-1);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(
    ...body.filter((l) => l.trim().length > 0).map((l) => l.match(/^ */)[0].length),
  );
  const script = body.map((l) => l.slice(indent)).join("\n");
  const block = /^WAIVERS = \{(?:\}$|[\s\S]*?^\}$)/m.exec(script)?.[0];
  expect(block, "the WAIVERS dict could not be located in sast.yml").toBeDefined();

  if (PYTHON3) {
    const run = spawnSync(
      "python3",
      ["-c", `${block}\nimport json\nprint(json.dumps(WAIVERS))\n`],
      { encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout)[ADVISORY];
  }
  const at = block.indexOf(`"${ADVISORY}":`);
  if (at === -1) return undefined;
  const entry = block.slice(at);
  return {
    expires: /"expires":\s*"([\d-]+)"/.exec(entry)?.[1] ?? "",
    packages: [...(/"packages":\s*\[([^\]]*)\]/.exec(entry)?.[1].matchAll(/"([^"]+)"/g) ?? [])].map(
      (m) => m[1],
    ),
    reason: /"reason"/.test(entry) ? "present" : "",
  };
}

describe("zod GHSA-mrhx-c7xc-m3w5 is closed or scoped-waived in the resolved tree (#1453)", () => {
  for (const manifest of ["server/package.json", "packages/shared/package.json"]) {
    it(`${manifest} declares zod at or above ${FLOOR}`, () => {
      const range = declaredZod(manifest);
      expect(range, `${manifest} no longer declares zod`).toBeDefined();
      expect(rangeMeetsFloor(range, FIXED), `${manifest} declares zod "${range}"`).toBe(true);
    });
  }

  it(`the zod override targets and bounds at ${FLOOR}, inside the 4.x band (#1208)`, () => {
    const entries = [...(effective?.entries() ?? [])].filter(
      ([key]) => key === "zod" || key.startsWith("zod@"),
    );
    // An empty list would pass every assertion in the loop below: fail-open.
    expect(entries, "no override governs zod").not.toHaveLength(0);
    for (const [key, target] of entries) {
      expect(rangeMeetsFloor(target, FIXED), `override "${key}" targets "${target}"`).toBe(true);
      const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      expect(ceiling, `override key "${key}" carries no upper bound`).toBeDefined();
      expect(
        resolvedVersionMeetsFloor(ceiling, FIXED),
        `override key "${key}" bounds at ${ceiling}, below the fixed ${FLOOR} (#1208)`,
      ).toBe(true);
      // Forcing botbuilder's `^3` across the major breaks it at import time
      // (`.nonstrict is not a function`), so the selector must not reach 3.x.
      expect(key, `override key "${key}" must stay inside the 4.x band`).toMatch(/>=\s*4\./);
    }
  });

  it(`resolves every zod copy at or above ${FLOOR}, except exactly the waived ${WAIVED_COPY}`, () => {
    const resolved = resolvedLockfileVersions(lockfile, "zod");
    expect(resolved.length, "expected at least one zod copy in the tree").toBeGreaterThan(0);
    expect(
      resolved.some((v) => resolvedVersionMeetsFloor(v, FIXED)),
      "no patched zod copy resolved at all",
    ).toBe(true);
    const breaching = resolved.filter(
      (v) => !resolvedVersionMeetsFloor(v, FIXED) && `zod@${v}` !== WAIVED_COPY,
    );
    expect(
      breaching,
      `lockfile resolves zod ${breaching.join(", ")} below ${FLOOR} and no waiver covers it`,
    ).toEqual([]);
  });

  it("server/ never launches puppeteer over WebDriver BiDi, the only path that loads chromium-bidi", () => {
    // puppeteer-core imports chromium-bidi (zod@3) only for `protocol: 'webDriverBiDi'`;
    // the waiver's chromium-bidi half rests on METIS keeping the CDP default.
    const exporters = readFileSync(
      resolve(REPO_ROOT, "server", "src", "lib", "docs-gen", "exporters.ts"),
      "utf8",
    );
    expect(exporters).toContain("puppeteer.default.launch(");
    expect(exporters).not.toMatch(/webDriverBiDi|protocol\s*:/);
  });

  it(`the ${ADVISORY} waiver is scoped to exactly ${WAIVED_COPY}, never the advisory at large`, () => {
    const w = liveWaiver();
    const stillVulnerable = resolvedLockfileVersions(lockfile, "zod").includes(
      WAIVED_COPY.slice("zod@".length),
    );
    if (!stillVulnerable) {
      // botbuilder moved off zod 3: the waiver is dead weight, and keeping it is how a
      // mute outlives its reason.
      expect(w, `${WAIVED_COPY} is gone from the tree; delete the ${ADVISORY} waiver`).toBe(
        undefined,
      );
      return;
    }
    expect(w, `${WAIVED_COPY} is in the tree but sast.yml has no ${ADVISORY} waiver`).toBeDefined();
    expect(w?.packages, "an unscoped waiver would also mute the zod 4 line").toEqual([WAIVED_COPY]);
    expect(w?.expires ?? "", "the waiver needs a review/expiry date").toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
    expect(w?.reason ?? "", "the waiver must say why").not.toBe("");
  });
});
