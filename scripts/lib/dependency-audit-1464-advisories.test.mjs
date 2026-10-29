import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  parseTopLevelOverrides,
  rangeMeetsFloor,
  resolvedLockfileVersions,
  resolvedVersionMeetsFloor,
} from "./pnpm-overrides-core.mjs";

/**
 * Regression guard for the three High advisories that turned `Dependency audit` red on
 * every PR on 2026-10-23 (#1464):
 *
 *   - undici GHSA-xjj6-f33q-929c (DoS on excessive content-encodings), fixed 7.30.1 /
 *     8.12.2 — UPGRADED: manifest floors plus overrides whose bound equals the floor.
 *   - @azure/msal-node GHSA-xcx6-jx8p-x3h5 (auth-code flow parameter disclosure), fixed
 *     7.1.0 — WAIVED, scoped to @azure/msal-node@5.3.0: no parent accepts 7.x and METIS
 *     never runs the flow (server/src/lib/teams/msal-auth-code-reachability.test.ts).
 *   - multer GHSA-q7qp-rjg7-q26m (crash from a pending ASYNC fileFilter), fixed 2.5.0 —
 *     waived for multer@2.4.0 until 2.5.0 cleared minimumReleaseAge, then UPGRADED (#1460):
 *     server/package.json declares ^2.5.0 and the waiver is deleted. No METIS upload sets
 *     a fileFilter at all; the scan below keeps it that way.
 *
 * Every arm reads the resolved lockfile, a declaring manifest, the gate's own waiver dict
 * or the source tree — never an override string alone.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lockfile = readFileSync(resolve(REPO_ROOT, "pnpm-lock.yaml"), "utf8");
const effective = parseTopLevelOverrides(lockfile);
const workflowText = readFileSync(resolve(REPO_ROOT, ".github", "workflows", "sast.yml"), "utf8");

const PYTHON3 = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" }).status === 0;

/** undici's affected bands: [introduced, fixed). */
const UNDICI_BANDS = /** @type {const} */ ([
  [
    [6, 23, 0],
    [6, 29, 1],
  ],
  [
    [7, 18, 0],
    [7, 30, 1],
  ],
  [
    [8, 0, 0],
    [8, 12, 2],
  ],
]);

const MSAL_ADVISORY = "GHSA-xcx6-jx8p-x3h5";
const MSAL_WAIVED = "@azure/msal-node@5.3.0";
/** About three months: a review date, not a release-age wait. Moving it is a decision. */
const MSAL_LATEST_EXPIRY = "2027-01-23";

const MULTER_ADVISORY = "GHSA-q7qp-rjg7-q26m";
const MULTER_FIXED = /** @type {const} */ ([2, 5, 0]);

function inBand(version, [introduced, fixed]) {
  return (
    resolvedVersionMeetsFloor(version, introduced) && !resolvedVersionMeetsFloor(version, fixed)
  );
}

const undiciVulnerable = (version) => UNDICI_BANDS.some((band) => inBand(version, band));

/**
 * The live waivers, read the way the gate reads them — the dict is executed in python3 when
 * available; otherwise each entry is sliced from the located block. "Not found" fails
 * instead of reading as "no waiver".
 *
 * @param {string} advisory
 * @returns {{ expires: string, packages?: string[], reason: string } | undefined}
 */
function liveWaiver(advisory) {
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
    return JSON.parse(run.stdout)[advisory];
  }
  const at = block.indexOf(`"${advisory}":`);
  if (at === -1) return undefined;
  const entry = block.slice(at, block.indexOf("},", at));
  return {
    expires: /"expires":\s*"([\d-]+)"/.exec(entry)?.[1] ?? "",
    packages: [...(/"packages":\s*\[([^\]]*)\]/.exec(entry)?.[1].matchAll(/"([^"]+)"/g) ?? [])].map(
      (m) => m[1],
    ),
    reason: /"reason"/.test(entry) ? "present" : "",
  };
}

function declared(manifestPath, name) {
  const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, manifestPath), "utf8"));
  for (const block of ["dependencies", "devDependencies", "optionalDependencies"]) {
    if (manifest[block]?.[name]) return manifest[block][name];
  }
  return undefined;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(m|c)?[jt]s$/.test(entry) && !/\.(test|spec)\.[jt]s$/.test(entry)) out.push(path);
  }
  return out;
}

describe("undici GHSA-xjj6-f33q-929c is closed in the resolved tree (#1464)", () => {
  it("classifies the advisory's bands correctly (the predicate the rest relies on)", () => {
    expect(undiciVulnerable("8.11.2")).toBe(true);
    expect(undiciVulnerable("8.12.2")).toBe(false);
    expect(undiciVulnerable("7.30.0")).toBe(true);
    expect(undiciVulnerable("7.30.1")).toBe(false);
    expect(undiciVulnerable("7.17.0")).toBe(false);
    expect(undiciVulnerable("6.29.0")).toBe(true);
  });

  for (const [manifest, floor] of /** @type {const} */ ([
    ["server/package.json", [8, 12, 2]],
    ["ui/package.json", [7, 30, 1]],
  ])) {
    it(`${manifest} declares undici at or above ${floor.join(".")}`, () => {
      const range = declared(manifest, "undici");
      expect(range, `${manifest} no longer declares undici`).toBeDefined();
      expect(rangeMeetsFloor(range, floor), `${manifest} declares undici "${range}"`).toBe(true);
    });
  }

  it("each undici override's bound equals its floor, at or above the fix (#1208)", () => {
    const entries = [...(effective?.entries() ?? [])].filter(([key]) => key.startsWith("undici@"));
    expect(entries, "no override governs undici").not.toHaveLength(0);
    for (const [key, target] of entries) {
      const ceiling = /<\s*(\d+\.\d+\.\d+)/.exec(key)?.[1];
      expect(ceiling, `override key "${key}" carries no upper bound`).toBeDefined();
      expect(target, `override "${key}" targets "${target}"`).toBe(`^${ceiling}`);
      expect(undiciVulnerable(ceiling), `override "${key}" lands inside an affected band`).toBe(
        false,
      );
    }
  });

  it("resolves no undici copy inside an affected band", () => {
    const resolved = resolvedLockfileVersions(lockfile, "undici");
    expect(resolved.length, "expected at least one undici copy").toBeGreaterThan(0);
    expect(resolved.filter(undiciVulnerable)).toEqual([]);
  });

  it("carries no waiver for the undici advisory: it is fixed, not muted", () => {
    expect(liveWaiver("GHSA-xjj6-f33q-929c")).toBeUndefined();
  });
});

describe("@azure/msal-node GHSA-xcx6-jx8p-x3h5 is scoped-waived to exactly the unfixable copy (#1464)", () => {
  const affected = resolvedLockfileVersions(lockfile, "@azure/msal-node").filter(
    (v) => resolvedVersionMeetsFloor(v, [5, 0, 0]) && !resolvedVersionMeetsFloor(v, [7, 1, 0]),
  );

  it("waives exactly the affected copies the lockfile resolves, or nothing once none remain", () => {
    const w = liveWaiver(MSAL_ADVISORY);
    if (affected.length === 0) {
      expect(w, `no affected msal-node is resolved; delete the ${MSAL_ADVISORY} waiver`).toBe(
        undefined,
      );
      return;
    }
    expect(affected.map((v) => `@azure/msal-node@${v}`)).toEqual([MSAL_WAIVED]);
    expect(w, `${MSAL_WAIVED} resolved but sast.yml has no ${MSAL_ADVISORY} waiver`).toBeDefined();
    expect(w?.packages).toEqual([MSAL_WAIVED]);
    expect(w?.reason ?? "").not.toBe("");
    expect(w?.expires <= MSAL_LATEST_EXPIRY, `waiver re-dated to ${w?.expires}`).toBe(true);
  });
});

describe("multer GHSA-q7qp-rjg7-q26m is fixed by upgrade, not waived (#1460)", () => {
  const resolved = resolvedLockfileVersions(lockfile, "multer");

  it("finds multer in the resolved tree (the checks below are not vacuous)", () => {
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("server/package.json declares multer at or above 2.5.0", () => {
    const range = declared("server/package.json", "multer");
    expect(range, "server/package.json no longer declares multer").toBeDefined();
    expect(
      rangeMeetsFloor(range, MULTER_FIXED),
      `server/package.json declares multer "${range}"`,
    ).toBe(true);
  });

  it("resolves every multer copy at or above 2.5.0", () => {
    const breaching = resolved.filter((v) => !resolvedVersionMeetsFloor(v, MULTER_FIXED));
    expect(breaching, `multer ${breaching.join(", ")} is inside ${MULTER_ADVISORY}`).toEqual([]);
  });

  it("carries no sast.yml waiver for the advisory: it is fixed, not muted", () => {
    expect(liveWaiver(MULTER_ADVISORY)).toBeUndefined();
  });

  it("no server source file configures a multer fileFilter", () => {
    // Deliberately blunt (#1465 review): a parser for "is this filter asynchronous?" missed
    // callback-style I/O, factory calls, member expressions and computed keys. 2.5.0 fixes
    // the crash, but a fileFilter is upload-path validation that deserves a human look: if
    // one is ever needed, review it by hand against GHSA-q7qp-rjg7-q26m, then narrow this
    // check to that file. Comments count too, so the token cannot hide behind one.
    const files = ["server/src", "server/embeddings-svc/src"].flatMap((d) =>
      walk(resolve(REPO_ROOT, d)),
    );
    const multerFiles = files.filter((f) => /from\s+["']multer["']/.test(readFileSync(f, "utf8")));
    // The three upload routes (documents, connectors, analysis): an empty list would mean
    // the walk is looking in the wrong place and the scan below is vacuous.
    expect(multerFiles.length, "no file imports multer; the scan is vacuous").toBeGreaterThan(0);
    const offenders = files
      .filter((f) => readFileSync(f, "utf8").includes("fileFilter"))
      .map((f) => relative(REPO_ROOT, f));
    expect(offenders).toEqual([]);
  });
});
