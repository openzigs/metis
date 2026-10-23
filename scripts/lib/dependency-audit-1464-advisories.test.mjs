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
 *     WAIVED, scoped to multer@2.4.0, until 2.5.0 clears minimumReleaseAge on 2026-10-29.
 *     No METIS upload sets an async fileFilter; the scan below keeps it that way.
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
/** The day after multer 2.5.0 clears minimumReleaseAge. Upgrade and delete; don't re-date. */
const MULTER_LATEST_EXPIRY = "2026-10-30";

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

// --- multer: asynchronous fileFilter detection ------------------------------------------

/** What makes a fileFilter call back after the request may already be torn down. */
const ASYNC_MARKERS =
  /\basync\b|\bawait\b|\.then\s*\(|\bPromise\b|\bsetTimeout\b|\bsetImmediate\b|\bnextTick\b|\bqueueMicrotask\b/;

/**
 * The text of one expression starting at `from`: up to the matching close of its first
 * brace block, or — for a brace-less expression — the next `,`, `;`, `)` or `}` at depth 0.
 */
function expressionAt(source, from) {
  let depth = 0;
  let sawBrace = false;
  for (let i = from; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{" || ch === "(" || ch === "[") {
      if (ch === "{") sawBrace = true;
      depth++;
    } else if (ch === "}" || ch === ")" || ch === "]") {
      if (depth === 0) return source.slice(from, i);
      depth--;
      if (depth === 0 && sawBrace && ch === "}") return source.slice(from, i + 1);
    } else if ((ch === "," || ch === ";") && depth === 0) {
      return source.slice(from, i);
    }
  }
  return source.slice(from);
}

/**
 * The declaration of `name` in `code` — `[async] function name(...) {...}` or
 * `const|let|var name = ...` — including any `async` keyword in front. Plain string search,
 * not an interpolated RegExp (Semgrep `detect-non-literal-regexp`).
 *
 * @returns {string | undefined}
 */
function declarationOf(code, name) {
  for (const keyword of ["function", "const", "let", "var"]) {
    for (const gap of [" ", "\t"]) {
      let at = code.indexOf(`${keyword}${gap}${name}`);
      while (at !== -1) {
        const after = code[at + keyword.length + 1 + name.length];
        if (!/[\w$]/.test(after ?? "")) {
          const head = code.slice(Math.max(0, at - 6), at);
          const body =
            keyword === "function"
              ? expressionAt(code, at)
              : expressionAt(code, code.indexOf("=", at) + 1);
          return head + body;
        }
        at = code.indexOf(`${keyword}${gap}${name}`, at + 1);
      }
    }
  }
  return undefined;
}

/**
 * Every `fileFilter` in one source file that is, or may be, asynchronous. An inline value
 * is inspected directly; a named one is followed to its declaration in the same file; one
 * that cannot be resolved here (imported, computed) is reported too, because it cannot be
 * shown synchronous.
 *
 * @param {string} source
 * @returns {string[]} one human-readable finding per offending fileFilter
 */
function asyncFileFilterFindings(source) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const findings = [];
  for (const match of code.matchAll(/\bfileFilter\b\s*(:|=|,|\}|\()?/g)) {
    const sep = match[1];
    let value;
    if (sep === ":" || sep === "=") {
      value = expressionAt(code, match.index + match[0].length).trim();
    } else if (sep === "," || sep === "}") {
      value = "fileFilter"; // shorthand property: `{ storage, fileFilter }`
    } else {
      continue; // a declaration (`function fileFilter(`) is examined when referenced
    }
    const name = /^[A-Za-z_$][\w$]*$/.exec(value)?.[0];
    if (name) {
      const declared = declarationOf(code, name);
      if (declared === undefined) {
        findings.push(`fileFilter "${name}" is not declared in this file; cannot show it is sync`);
        continue;
      }
      value = declared;
    }
    if (ASYNC_MARKERS.test(value)) {
      findings.push(`asynchronous fileFilter: ${value.replace(/\s+/g, " ").slice(0, 120)}`);
    }
  }
  return findings;
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

describe("multer GHSA-q7qp-rjg7-q26m: no async fileFilter while 2.4.0 is waived (#1464)", () => {
  const resolved = resolvedLockfileVersions(lockfile, "multer");
  const vulnerable = resolved
    .filter(
      (v) => resolvedVersionMeetsFloor(v, [2, 0, 0]) && !resolvedVersionMeetsFloor(v, MULTER_FIXED),
    )
    .map((v) => `multer@${v}`);

  it("finds multer in the resolved tree (the checks below are not vacuous)", () => {
    expect(resolved.length).toBeGreaterThan(0);
  });

  it("waives exactly the vulnerable copies, or nothing once upgraded", () => {
    const w = liveWaiver(MULTER_ADVISORY);
    if (vulnerable.length === 0) {
      expect(w, `no vulnerable multer is resolved; delete the ${MULTER_ADVISORY} waiver`).toBe(
        undefined,
      );
      return;
    }
    expect(w, `${vulnerable.join(", ")} resolved but sast.yml has no waiver`).toBeDefined();
    expect([...(w?.packages ?? [])].sort()).toEqual([...vulnerable].sort());
    expect(w?.reason ?? "").not.toBe("");
  });

  it(`never lets the waiver run past ${MULTER_LATEST_EXPIRY}: upgrade and delete, don't re-date`, () => {
    const w = liveWaiver(MULTER_ADVISORY);
    if (w === undefined) return;
    expect(w.expires <= MULTER_LATEST_EXPIRY, `waiver re-dated to ${w.expires}`).toBe(true);
  });

  describe("asyncFileFilterFindings (the detector the source scan relies on)", () => {
    it("passes multer's default (no fileFilter) and a synchronous inline filter", () => {
      expect(asyncFileFilterFindings("multer({ storage: multer.memoryStorage() })")).toEqual([]);
      expect(
        asyncFileFilterFindings(
          "multer({ fileFilter: (req, file, cb) => { cb(null, file.mimetype === 'text/csv'); }, limits: {} })",
        ),
      ).toEqual([]);
    });

    it("passes a synchronous named filter declared in the same file", () => {
      const src =
        "function onlyCsv(req, file, cb) { cb(null, true); }\nmulter({ fileFilter: onlyCsv });";
      expect(asyncFileFilterFindings(src)).toEqual([]);
    });

    it.each([
      ["an async arrow", "multer({ fileFilter: async (req, file, cb) => { cb(null, true); } })"],
      [
        "a .then() callback",
        "multer({ fileFilter: (r, f, cb) => { check(f).then(() => cb(null, true)); } })",
      ],
      [
        "an await inside",
        "multer({ fileFilter: function (r, f, cb) { void (async () => { await av(f); cb(null, true); })(); } })",
      ],
      [
        "a deferred callback",
        "multer({ fileFilter: (r, f, cb) => { setImmediate(() => cb(null, true)); } })",
      ],
      [
        "an async named function",
        "async function scan(req, file, cb) { await av(file); cb(null, true); }\nmulter({ fileFilter: scan });",
      ],
      [
        "an async const, shorthand",
        "const fileFilter = async (req, file, cb) => cb(null, true);\nmulter({ storage, fileFilter });",
      ],
      ["an imported filter", "import { scan } from './av.js';\nmulter({ fileFilter: scan });"],
      [
        "a filter returning a promise",
        "multer({ fileFilter: (r, f, cb) => Promise.resolve().then(() => cb(null, true)) })",
      ],
    ])("flags %s", (_label, src) => {
      expect(asyncFileFilterFindings(src).length).toBeGreaterThan(0);
    });

    it("ignores fileFilter mentioned only in a comment", () => {
      expect(asyncFileFilterFindings("// fileFilter: async () => {}\nmulter({})")).toEqual([]);
    });
  });

  it("no server source file configures an asynchronous fileFilter", () => {
    const files = ["server/src", "server/embeddings-svc/src"].flatMap((d) =>
      walk(resolve(REPO_ROOT, d)),
    );
    const multerFiles = files.filter((f) => /from\s+["']multer["']/.test(readFileSync(f, "utf8")));
    // The three upload routes (documents, connectors, analysis): an empty list would make
    // the scan below vacuous.
    expect(multerFiles.length, "no file imports multer; the scan is vacuous").toBeGreaterThan(0);
    const findings = files.flatMap((f) =>
      asyncFileFilterFindings(readFileSync(f, "utf8")).map(
        (msg) => `${relative(REPO_ROOT, f)}: ${msg}`,
      ),
    );
    expect(findings).toEqual([]);
  });
});
