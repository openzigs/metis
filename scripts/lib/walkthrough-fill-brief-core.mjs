/**
 * #954 — fill the walkthrough's wave briefs (`.github/skills/e2e-walkthrough/briefs/*.md`) from
 * a per-run state file and the reviewed `fixes.json`.
 *
 * Before #954 this was a Python helper in a session scratchpad, with the fixes to verify typed
 * into a `FIXES` dict. Now `{{FIXES_TO_VERIFY}}` is generated per wave from `fixes.json`, and
 * the helper refuses to write anything when:
 *
 *  - a brief still has an unfilled `{{PLACEHOLDER}}` (a dispatched agent would act on the
 *    literal text);
 *  - `fixes.json` still has `unmapped` entries (a relevant PR nobody placed in a wave);
 *  - a PR the state file marks as required is missing from `fixes[]`;
 *  - a brief's file name maps to no wave.
 *
 * The runner, `scripts/walkthrough/fill-brief.mjs`, is argv glue around `runFillBrief`.
 */

import path from "node:path";

import { fixLine, isPlainObject, orderFixes, parseFixesDoc } from "./walkthrough-fixes-core.mjs";

/** Which wave each brief verifies fixes in. */
export const BRIEF_WAVES = /** @type {Record<string, string>} */ ({
  "wave-a.md": "A",
  "wave-b.md": "B",
  "wave-c.md": "C",
  "wave-d.md": "D",
  "wave-e.md": "E",
  "wave-f.md": "F",
  "ba-reask.md": "BA",
});

/** Filled from `fixes.json`, never from the state file. */
export const GENERATED_PLACEHOLDERS = ["FIXES_TO_VERIFY"];

const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export const BRIEFS_DIR = ".github/skills/e2e-walkthrough/briefs";

export const USAGE =
  "Usage: fill-brief.mjs --state <state.json> --fixes <fixes.json> --out <dir> [--briefs <dir>] [--wave A,B,...]";

/**
 * @typedef {object} BriefState
 * @property {Record<string, string>} placeholders
 * @property {number[]} requiredPrs
 */

/**
 * Parse and validate the per-run state file:
 * `{ "placeholders": { "RUN_NUMBER": "5", … }, "requiredPrs": [952] }`.
 *
 * @param {string} text
 * @returns {{ state: BriefState | null, errors: string[] }}
 */
export function parseState(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: null, errors: ["state: not valid JSON"] };
  }
  if (!isPlainObject(raw)) return { state: null, errors: ["state: expected a JSON object"] };
  /** @type {string[]} */
  const errors = [];
  for (const key of Object.keys(raw)) {
    if (!["placeholders", "requiredPrs"].includes(key)) {
      errors.push(`state: unknown field "${key}"`);
    }
  }
  const placeholders = raw.placeholders;
  if (!isPlainObject(placeholders)) {
    errors.push(`state: "placeholders" must be an object`);
  } else {
    for (const [key, value] of Object.entries(placeholders)) {
      if (!KEY_RE.test(key)) errors.push(`state placeholders.${key}: key must be UPPER_SNAKE`);
      if (GENERATED_PLACEHOLDERS.includes(key)) {
        errors.push(`state placeholders.${key}: generated from fixes.json, do not set it`);
      }
      if (typeof value !== "string" || value.trim() === "") {
        errors.push(`state placeholders.${key}: value must be a non-empty string`);
      }
    }
  }
  const required = raw.requiredPrs ?? [];
  if (!(Array.isArray(required) && required.every((n) => Number.isInteger(n) && n > 0))) {
    errors.push(`state: "requiredPrs" must be an array of positive PR numbers`);
  }
  if (errors.length > 0) return { state: null, errors };
  return {
    state: {
      placeholders: /** @type {Record<string, string>} */ (placeholders),
      requiredPrs: /** @type {number[]} */ (required),
    },
    errors: [],
  };
}

/**
 * The `{{FIXES_TO_VERIFY}}` text for one wave.
 *
 * @param {import("./walkthrough-fixes-core.mjs").Fix[]} fixes
 * @param {string} wave
 * @returns {string}
 */
export function renderFixesForWave(fixes, wave) {
  const list = orderFixes(fixes).filter((f) => f.wave === wave);
  return list.length ? list.map(fixLine).join("\n") : "None in this wave.";
}

/**
 * Substitute every `{{KEY}}`; report the keys that had no value.
 *
 * @param {string} text
 * @param {Record<string, string>} values
 * @returns {{ text: string, missing: string[] }}
 */
export function fillTemplate(text, values) {
  /** @type {Set<string>} */
  const missing = new Set();
  const out = text.replace(PLACEHOLDER_RE, (whole, key) => {
    if (Object.hasOwn(values, key)) return values[key];
    missing.add(key);
    return whole;
  });
  return { text: out, missing: [...missing].sort() };
}

/**
 * Fill every brief, or report every reason not to.
 *
 * With `waves`, only those waves' briefs are filled and checked for unfilled placeholders (a
 * later wave's IDs do not exist yet); the unmapped, required-PR and unknown-brief checks stay
 * run-wide.
 *
 * @param {{ briefs: Record<string, string>, state: BriefState, fixesDoc: import("./walkthrough-fixes-core.mjs").FixesDoc, waves?: string[] }} input
 * @returns {{ outputs: Record<string, string>, errors: string[] }}
 */
export function fillBriefs(input) {
  const { briefs, state, fixesDoc, waves } = input;
  /** @type {string[]} */
  const errors = [];
  /** @type {Record<string, string>} */
  const outputs = {};

  for (const u of fixesDoc.unmapped) {
    errors.push(`fixes.json: PR #${u.pr} is relevant but placed in no wave (${u.reason})`);
  }
  const listed = new Set(fixesDoc.fixes.map((f) => f.pr));
  for (const pr of state.requiredPrs) {
    if (!listed.has(pr)) errors.push(`required PR #${pr} is missing from fixes.json fixes[]`);
  }

  for (const [name, text] of Object.entries(briefs).sort(([a], [b]) => a.localeCompare(b))) {
    const wave = BRIEF_WAVES[name];
    if (!wave) {
      errors.push(`${name}: no wave for this brief; add it to BRIEF_WAVES`);
      continue;
    }
    if (waves && !waves.includes(wave)) continue;
    const filled = fillTemplate(text, {
      ...state.placeholders,
      FIXES_TO_VERIFY: renderFixesForWave(fixesDoc.fixes, wave),
    });
    for (const key of filled.missing) errors.push(`${name}: unfilled placeholder {{${key}}}`);
    outputs[name] = filled.text;
  }
  return errors.length > 0 ? { outputs: {}, errors } : { outputs, errors: [] };
}

/**
 * @typedef {object} FillIo
 * @property {(file: string) => string} readFile
 * @property {(dir: string) => string[]} listDir
 * @property {(file: string, text: string) => void} writeFile
 * @property {(dir: string) => void} mkdir
 * @property {(msg: string) => void} log
 * @property {(msg: string) => void} error
 */

/**
 * @param {string[]} argv
 * @param {FillIo} io
 * @returns {number} exit code: 0 written, 1 refused, 2 bad arguments
 */
export function runFillBrief(argv, io) {
  /** @type {Record<string, string>} */
  const flags = {};
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (
      !["--state", "--fixes", "--out", "--briefs", "--wave"].includes(flag) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      io.error(`bad argument "${flag}"\n${USAGE}`);
      return 2;
    }
    flags[flag] = value;
  }
  /** @type {string[] | undefined} */
  let waves;
  if (flags["--wave"] !== undefined) {
    waves = flags["--wave"].split(",");
    const known = new Set(Object.values(BRIEF_WAVES));
    const bad = waves.filter((w) => !known.has(w));
    if (bad.length > 0) {
      io.error(`--wave: unknown wave ${bad.join(", ")}; expected ${[...known].join(", ")}\n${USAGE}`);
      return 2;
    }
  }
  for (const flag of ["--state", "--fixes", "--out"]) {
    if (flags[flag] === undefined) {
      io.error(`${flag} is required\n${USAGE}`);
      return 2;
    }
  }
  try {
    const parsedState = parseState(io.readFile(flags["--state"]));
    const parsedFixes = parseFixesDoc(io.readFile(flags["--fixes"]));
    const errors = [...parsedState.errors, ...parsedFixes.errors];
    if (!parsedState.state || !parsedFixes.doc) {
      io.error(`fill-brief refused:\n  ${errors.join("\n  ")}`);
      return 1;
    }
    const briefsDir = flags["--briefs"] ?? BRIEFS_DIR;
    /** @type {Record<string, string>} */
    const briefs = {};
    for (const name of io.listDir(briefsDir).filter((n) => n.endsWith(".md"))) {
      briefs[name] = io.readFile(path.join(briefsDir, name));
    }
    if (Object.keys(briefs).length === 0) {
      io.error(`fill-brief refused: no briefs in ${briefsDir}`);
      return 1;
    }
    const result = fillBriefs({
      briefs,
      state: parsedState.state,
      fixesDoc: parsedFixes.doc,
      waves,
    });
    if (result.errors.length > 0) {
      io.error(`fill-brief refused; nothing written:\n  ${result.errors.join("\n  ")}`);
      return 1;
    }
    io.mkdir(flags["--out"]);
    for (const [name, text] of Object.entries(result.outputs)) {
      io.writeFile(path.join(flags["--out"], name), text);
    }
    io.log(`Filled ${Object.keys(result.outputs).length} brief(s) into ${flags["--out"]}.`);
    return 0;
  } catch (err) {
    io.error(`fill-brief failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
