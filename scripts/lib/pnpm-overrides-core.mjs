/**
 * Effective-override guard (#1213).
 *
 * ## Why this reads the lockfile
 *
 * pnpm 11 no longer reads the `pnpm` field of `package.json`. Measured on 11.18.0:
 *
 *   [WARN] The "pnpm" field in package.json is no longer read by pnpm. The following
 *          keys were ignored: "pnpm.overrides", "pnpm.onlyBuiltDependencies".
 *
 * A WARNING, with exit 0. The first install that regenerates the lockfile after a
 * `packageManager` bump drops the lockfile's `overrides:` block and every pin stops
 * applying at once — on this repo's real graph that measurably restored `postcss@8.5.15`,
 * `ws@7.5.13`/`8.18.3` and `esbuild@0.27.7`, each pinned away by a HIGH advisory.
 *
 * The guard #1208 shipped read `manifest.pnpm.overrides` — the ignored field — so it
 * would have reported 4/4 throughout. This module therefore asserts against the
 * **outcome**: the lockfile's top-level `overrides:` block is pnpm's own record of what
 * it actually applied, and `--frozen-lockfile` (which every CI job uses) refuses to
 * proceed when it disagrees with the effective configuration
 * (`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, verified). That makes the lockfile an honest
 * proxy for effective config rather than a restatement of intent.
 *
 * Everything here is pure and takes file *text*, so the mutation matrix in the sibling
 * test can put the tree into states that are awkward to create on disk — in particular
 * "declared but not honoured", which is the state the old guard could not see.
 */

import { readdirSync as nodeReaddirSync, readFileSync as nodeReadFileSync } from "node:fs";

/**
 * Earliest pnpm that honours `overrides:` in `pnpm-workspace.yaml`. **Measured, not
 * inferred** — every row below was run here, on a scratch workspace with `packages:`
 * present (so the file parses) and one override `brace-expansion@1: 1.1.16` against a
 * direct dependency on `^1.1.11`:
 *
 *   pnpm     exit  lockfile `overrides:`  resolved   verdict
 *   -------  ----  ---------------------  ---------  -------------------
 *    9.15.9    0   absent                 1.1.18     IGNORED, no warning
 *   10.0.0     0   absent                 1.1.18     IGNORED, no warning
 *   10.4.0     0   absent                 1.1.18     IGNORED, no warning
 *   10.4.1     0   absent                 1.1.18     IGNORED, no warning
 *   10.5.0     0   absent                 1.1.18     IGNORED, no warning
 *   10.5.1     0   present                1.1.16     APPLIED  <-- the floor
 *   10.5.2     0   present                1.1.16     APPLIED
 *   10.33.0    0   present                1.1.16     APPLIED
 *   11.18.0    0   present                1.1.16     APPLIED
 *
 * Corroborated upstream: pnpm's own v10.5.1 release notes carry the line
 * "Specifying `overrides` in `pnpm-workspace.yaml` should work."
 *
 * **This is why the floor is a hard requirement of #1213, not a tidy-up.** Before the
 * migration the overrides lived in `package.json`, which every version above reads, so
 * `engines.pnpm: ">=9.0.0"` was harmless. After it, that same range admits the entire
 * ignoring band — and the failure there is *quieter* than the pnpm 11 one this module was
 * written for: pnpm 11 at least emits `[WARN]` naming the ignored keys, whereas pnpm
 * 9/10.0–10.5.0 say **nothing at all** and exit 0 having applied zero of the 26 pins.
 *
 * The CI path is protected by a different mechanism: `pnpm install --frozen-lockfile`
 * under 10.5.0 against a lockfile carrying the block fails loudly with
 * `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` (measured). But — exactly as with pnpm 11 — that
 * error's own remedy text says `Update your lockfile using "pnpm install
 * --no-frozen-lockfile"`, and running it strips the block and exits 0. The loud failure's
 * suggested fix is the silent one, which is why a floor is worth stating at all.
 *
 * **Who is actually exposed, measured rather than assumed.** With `packageManager:
 * pnpm@10.33.0` in the manifest, a pnpm **10.x** launcher self-switches to 10.33.0 before
 * resolving anything (`managePackageManagerVersions` defaults on in pnpm 10) — 10.0.0 and
 * 10.5.0 both reported `Done ... using pnpm v10.33.0` and applied the overrides. pnpm
 * **9** does not self-switch: 9.15.9 ran as itself and wrote a lockfile with no
 * `overrides:` block. So the genuinely exposed band is pnpm 9, plus any 10.x with
 * self-switching disabled — narrower than "everything below 10.5.1", and stated that way
 * because overstating it would be the same sin as the folklore this replaces.
 */
export const WORKSPACE_OVERRIDES_FLOOR = Object.freeze([10, 5, 1]);

/**
 * The floor `engines.pnpm` must actually declare — **higher than the overrides boundary
 * above**, and deliberately so.
 *
 * `WORKSPACE_OVERRIDES_FLOOR` answers one narrow question: when did `overrides:` start
 * working. But `engines.pnpm` guards the whole of `pnpm-workspace.yaml`, and the file
 * carries a second security-relevant key from #586 — `minimumReleaseAge: 10080`, the
 * seven-day quarantine on newly published versions. That key is **silently inert** below
 * pnpm 10.16.0: measured, 10.5.1 and 10.15.0 resolve with the age gate never applied and
 * exit 0, while 10.16.0 applies it (the file's own comment says the same). A floor of
 * 10.5.1 would therefore certify a pnpm at which part of this file's supply-chain
 * hardening quietly does nothing — the exact failure mode #1213 exists to end, one key
 * over. So the floor is the highest requirement in the file, not the one that prompted it.
 *
 * `packageManager` stays at 10.33.0 and is untouched; corepack pins that for anyone using
 * corepack, and this floor is the guard for anyone who is not.
 */
export const ENGINES_PNPM_FLOOR = Object.freeze([10, 16, 0]);

/** Thrown when an overrides block cannot be read. Never swallowed into a skip. */
export class OverridesParseError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "OverridesParseError";
  }
}

/**
 * Remove a trailing YAML comment from a scalar.
 *
 * In YAML a `#` starts a comment only at the start of the scalar or when preceded by
 * whitespace, so `^1.0.0#notacomment` is a value while `^1.0.0 # GHSA-x` is a value plus
 * a comment. A quoted scalar ends at its closing quote and anything after it is comment
 * or nothing.
 *
 * Without this, `overrides: # security pins` threw as an "inline value" and
 * `ws@<8.21.0: ^8.21.0 # GHSA-x` parsed its value as `"^8.21.0 # GHSA-x"` — the second
 * being the worse failure, because it produces a bogus MISMATCH rather than an error.
 * Both are valid YAML that pnpm honours, in a file whose every other section is
 * commented.
 *
 * @param {string} raw
 * @returns {string}
 */
function stripTrailingComment(raw) {
  const value = raw.trim();
  if (value.startsWith("#")) return "";
  if (value.startsWith("'") || value.startsWith('"')) {
    const quote = value[0];
    let i = 1;
    while (i < value.length) {
      if (value[i] === quote) {
        if (quote === "'" && value[i + 1] === "'") i += 2;
        else return value.slice(0, i + 1);
      } else i += 1;
    }
    return value; // unterminated — leave it for the caller to reject
  }
  const comment = value.search(/\s#/);
  return comment === -1 ? value : value.slice(0, comment).trim();
}

/**
 * Strip YAML quoting from a scalar. Quoting is syntax, not meaning.
 * @param {string} raw
 * @returns {string}
 */
function unquote(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  return value;
}

/**
 * Split an `key: value` entry line, honouring a quoted key (which may itself contain
 * a colon). Returns null when the line is not a mapping entry at all.
 *
 * @param {string} body
 * @returns {[string, string] | null}
 */
function splitEntry(body) {
  if (body.startsWith("'") || body.startsWith('"')) {
    const quote = body[0];
    let index = 1;
    while (index < body.length) {
      if (body[index] === quote) {
        // A doubled quote inside a single-quoted scalar is an escaped quote.
        if (quote === "'" && body[index + 1] === "'") index += 2;
        else break;
      } else index += 1;
    }
    if (index >= body.length) return null; // unterminated quote
    const rest = body.slice(index + 1);
    if (!rest.startsWith(":")) return null;
    return [body.slice(0, index + 1), rest.slice(1)];
  }
  const colon = body.indexOf(":");
  if (colon === -1) return null;
  return [body.slice(0, colon), body.slice(colon + 1)];
}

/**
 * Parse the **top-level** `overrides:` mapping out of a YAML document.
 *
 * Returns a `Map` of override key -> range, or `null` when the document has no
 * top-level `overrides:` key at all.
 *
 * `null` and an empty `Map` are deliberately distinct. `null` means "pnpm applied no
 * override block" — the pnpm 11 failure state. An empty `Map` means "it applied an
 * empty one". Collapsing both to `{}` is the "default that means nothing to check"
 * shape that produced #1168, so callers are made to tell them apart.
 *
 * Only a **column-0** `overrides:` counts. An indented one is nested under some other
 * key, is not what pnpm reads, and must not manufacture a green.
 *
 * @param {string} text
 * @returns {Map<string, string> | null}
 */
export function parseTopLevelOverrides(text) {
  if (typeof text !== "string") {
    throw new OverridesParseError(`expected YAML text, received ${typeof text}`);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^overrides:/.test(line));
  if (start === -1) return null;

  const overrides = new Map();

  // `overrides: {}` — an explicit empty flow mapping on the same line. A trailing
  // comment (`overrides: # security pins`) is valid YAML and means "no inline value".
  const inline = stripTrailingComment(lines[start].slice("overrides:".length));
  if (inline !== "") {
    if (inline === "{}") return overrides;
    throw new OverridesParseError(`unsupported inline overrides value: ${inline}`);
  }

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) break; // next top-level key ends the block

    const split = splitEntry(line.trim());
    if (!split) {
      throw new OverridesParseError(`cannot read overrides entry on line ${i + 1}: ${line.trim()}`);
    }
    const [rawKey, rawValue] = split;
    const value = stripTrailingComment(rawValue);
    if (value === "") {
      throw new OverridesParseError(
        `overrides entry "${unquote(rawKey)}" on line ${i + 1} has no value; ` +
          `a nested mapping is not a valid override`,
      );
    }
    overrides.set(unquote(rawKey), unquote(value));
  }
  return overrides;
}

/**
 * Parse the top-level `packages:` list out of `pnpm-workspace.yaml`.
 *
 * @param {string} text
 * @returns {string[] | null} the declared patterns, or null when there is no list
 */
export function parseWorkspacePackages(text) {
  if (typeof text !== "string") {
    throw new OverridesParseError(`expected YAML text, received ${typeof text}`);
  }
  const lines = text.split("\n");
  const start = lines.findIndex((line) => /^packages:/.test(line));
  if (start === -1) return null;

  const patterns = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith(" ")) break; // next top-level key ends the block
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (!item) {
      throw new OverridesParseError(`cannot read packages entry on line ${i + 1}: ${line.trim()}`);
    }
    patterns.push(unquote(stripTrailingComment(item[1])));
  }
  return patterns;
}

/**
 * Enumerate the manifests pnpm itself considers: the root `package.json` plus one per
 * workspace package declared in `pnpm-workspace.yaml`.
 *
 * **This is deliberately NOT a walk of the checkout.** An earlier version recursed the
 * whole tree, which visited ~11,300 directories and — more importantly — swept in
 * `server/data/repo-clones`, `repo-extracts` and `uploads`. Those are gitignored
 * directories into which METIS's *own ingest* writes third-party source, `package.json`
 * files included. A cloned repo carrying a `pnpm` field, or simply JSON this parser
 * cannot read, would then turn a developer's `pnpm test` red for a file that is not this
 * repo's dependency configuration at all. Deriving the domain from `packages:` fixes
 * that at the root: it is exactly the set pnpm reads, so it cannot drift from what is
 * being guarded, and no ignored directory can enter it.
 *
 * A declared package with no readable manifest is reported in `missing` rather than
 * skipped, so a typo in `packages:` cannot quietly shrink the domain.
 *
 * @param {string} rootDir
 * @param {string} workspaceText contents of `pnpm-workspace.yaml`
 * @param {{ readdirSync?: Function, readFileSync?: Function }} [io] test seam
 * @returns {{ manifests: Array<{ path: string, text: string }>, missing: string[] }}
 */
export function findWorkspaceManifests(rootDir, workspaceText, io = {}) {
  const readdirSync = io.readdirSync ?? nodeReaddirSync;
  const readFileSync = io.readFileSync ?? nodeReadFileSync;

  const dirs = ["."];
  for (const pattern of parseWorkspacePackages(workspaceText) ?? []) {
    if (pattern.endsWith("/*")) {
      const parent = pattern.slice(0, -2);
      let entries = [];
      try {
        entries = readdirSync(`${rootDir}/${parent}`, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith("."))
          dirs.push(`${parent}/${entry.name}`);
      }
    } else if (pattern.includes("*")) {
      // Fail closed: an unsupported glob would silently shrink the domain.
      throw new OverridesParseError(
        `unsupported workspace package pattern "${pattern}"; only literal paths and a ` +
          `trailing "/*" are understood`,
      );
    } else {
      dirs.push(pattern.replace(/\/+$/, ""));
    }
  }

  /** @type {Array<{ path: string, text: string }>} */
  const manifests = [];
  /** @type {string[]} */
  const missing = [];
  for (const dir of dirs) {
    const rel = dir === "." ? "package.json" : `${dir}/package.json`;
    try {
      manifests.push({ path: rel, text: readFileSync(`${rootDir}/${rel}`, "utf8") });
    } catch {
      missing.push(rel);
    }
  }
  return { manifests, missing };
}

/**
 * Report every manifest that still declares a `pnpm` field, with the keys it holds.
 *
 * Any such field is dead configuration under pnpm 11 regardless of whether the tree
 * happens to be correct today, so this is checked independently of the value diff —
 * it is the *identity* axis: right values, wrong source.
 *
 * @param {Array<{ path: string, text: string }>} manifests
 * @returns {Array<{ path: string, keys: string[], unreadable?: boolean }>}
 */
export function collectPnpmFieldDeclarations(manifests) {
  if (!Array.isArray(manifests)) {
    throw new TypeError("collectPnpmFieldDeclarations requires an array of manifests");
  }
  const found = [];
  for (const manifest of manifests) {
    let parsed;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      // Unreadable is REPORTED, never skipped: skipping is how a file escapes the check.
      found.push({ path: manifest.path, keys: [], unreadable: true });
      continue;
    }
    if (parsed && typeof parsed.pnpm === "object" && parsed.pnpm !== null) {
      found.push({ path: manifest.path, keys: Object.keys(parsed.pnpm) });
    }
  }
  return found;
}

/**
 * Compare declared overrides against the ones actually applied, in **both**
 * directions. A one-directional check passes a lockfile carrying pins nobody declares.
 *
 * @param {Map<string, string>} declared
 * @param {Map<string, string>} effective
 */
export function diffOverrideMaps(declared, effective) {
  const missing = [];
  const mismatched = [];
  for (const [key, value] of declared) {
    if (!effective.has(key)) missing.push(key);
    else if (effective.get(key) !== value) {
      mismatched.push({ key, declared: value, effective: effective.get(key) });
    }
  }
  const extra = [...effective.keys()].filter((key) => !declared.has(key));
  return { missing, extra, mismatched };
}

/**
 * The single verdict: are this repo's dependency overrides declared where pnpm reads
 * them, and did pnpm actually apply them?
 *
 * @param {object} input
 * @param {Array<{ path: string, text: string }>} input.manifests every package.json
 * @param {string} input.workspaceText  `pnpm-workspace.yaml`
 * @param {string} input.lockfileText   `pnpm-lock.yaml`
 * @param {number} input.minimumOverrides floor below which the set is treated as
 *   collapsed. **Required** — defaulting it to 0 would read as "nothing to check".
 * @returns {{ ok: boolean, problems: Array<Record<string, unknown>>,
 *             declared: Map<string, string> | null, effective: Map<string, string> | null }}
 */
export function auditOverrides({ manifests, workspaceText, lockfileText, minimumOverrides }) {
  if (typeof minimumOverrides !== "number" || Number.isNaN(minimumOverrides)) {
    throw new TypeError(
      "auditOverrides requires an explicit numeric `minimumOverrides`; a default of 0 " +
        "would let a collapsed override set pass as 'nothing to check'",
    );
  }
  const problems = [];

  for (const declaration of collectPnpmFieldDeclarations(manifests)) {
    if (declaration.unreadable) {
      problems.push({
        kind: "unreadable-manifest",
        path: declaration.path,
        message: `${declaration.path} is not valid JSON, so it cannot be checked for a "pnpm" field`,
      });
      continue;
    }
    problems.push({
      kind: "pnpm-field-present",
      path: declaration.path,
      keys: declaration.keys,
      message:
        `${declaration.path} declares a "pnpm" field (${declaration.keys.join(", ")}), which is ` +
        `no longer read by pnpm 11 — it is ignored with a WARNING and exit 0. Move these ` +
        `settings into pnpm-workspace.yaml (#1213).`,
    });
  }

  let declared = null;
  let effective = null;
  try {
    declared = parseTopLevelOverrides(workspaceText);
    effective = parseTopLevelOverrides(lockfileText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    problems.push({ kind: "malformed-overrides", message });
    return { ok: false, problems, declared, effective };
  }

  const declaredMap = declared ?? new Map();

  if (effective === null) {
    if (declaredMap.size > 0 || problems.some((p) => p.kind === "pnpm-field-present")) {
      problems.push({
        kind: "overrides-not-applied",
        message:
          "pnpm-lock.yaml has no top-level `overrides:` block, so NO override was applied — " +
          "but overrides are declared. This is exactly the state a pnpm 11 upgrade produces " +
          "from a package.json `pnpm` field: declared, ignored, exit 0.",
      });
    } else if (minimumOverrides > 0) {
      // Nothing declared AND nothing applied. Every diff below is vacuously satisfied by
      // that state, and an ABSENT block is the shape pnpm actually writes — `overrides: {}`
      // is not. Falling through the early return without consulting the floor was the
      // "nothing to check" fail-open all over again, inside the fix for one (#1168, #1213).
      problems.push({
        kind: "too-few-overrides",
        message:
          `no overrides are declared and none are applied, against an expected floor of ` +
          `${minimumOverrides}. A total collapse is internally consistent and satisfies ` +
          `every other check, so the floor is the only thing that sees it.`,
      });
    }
    return { ok: problems.length === 0, problems, declared, effective };
  }

  const { missing, extra, mismatched } = diffOverrideMaps(declaredMap, effective);
  for (const key of missing) {
    problems.push({
      kind: "override-missing",
      key,
      message: `override "${key}" is declared but the lockfile did not apply it`,
    });
  }
  for (const key of extra) {
    problems.push({
      kind: "override-extra",
      key,
      message: `the lockfile applies override "${key}", which nothing declares — stale lockfile`,
    });
  }
  for (const entry of mismatched) {
    problems.push({
      kind: "override-mismatched",
      ...entry,
      message: `override "${entry.key}" is declared as "${entry.declared}" but the lockfile applied "${entry.effective}"`,
    });
  }

  if (effective.size < minimumOverrides) {
    problems.push({
      kind: "too-few-overrides",
      message:
        `only ${effective.size} override(s) are in effect, below the expected floor of ` +
        `${minimumOverrides}. An empty-but-consistent override set satisfies every diff ` +
        `above, so the floor is what stops a total collapse passing as healthy.`,
    });
  }

  return { ok: problems.length === 0, problems, declared, effective };
}

/**
 * Lowest version an override range can install (its floor).
 * @param {string} range
 * @returns {[number, number, number]}
 */
export function floorOf(range) {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (!match) throw new OverridesParseError(`cannot read a version floor from ${range}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export const UNBOUNDED = Number.POSITIVE_INFINITY;

/**
 * Highest major `range` could install, or `UNBOUNDED` when it has no upper bound.
 *
 * A range's floor says nothing about its ceiling: `">=1.1.17"` has an in-major floor
 * and installs 5.0.9 quite happily (#1208 M5). `^`/`~`/exact cap themselves; a bare
 * comparator range is capped only by an explicit `<`/`<=` term; a disjunction is as
 * loose as its loosest arm. Anything unparsable is reported unbounded, so an
 * unrecognised form fails the guard rather than slipping past it.
 *
 * @param {string} range
 * @returns {number}
 */
export function ceilingMajorOf(range) {
  const spec = String(range).trim();
  if (spec.includes("||")) return Math.max(...spec.split("||").map(ceilingMajorOf));
  if (spec === "" || /^(\*|x|latest)$/i.test(spec)) return UNBOUNDED;

  let ceiling = UNBOUNDED;
  for (const term of spec.split(/\s+/)) {
    const match = /^(\^|~|<=|<|>=|>|=)?v?(\d+)\.(\d+)\.(\d+)\S*$/.exec(term);
    if (!match) return UNBOUNDED; // hyphen ranges, `1.x`, junk — assume the worst
    const [, operator = "", major, minor, patch] = match;
    if (operator === ">=" || operator === ">") continue; // lower bound only
    const cap =
      operator === "<" && Number(minor) === 0 && Number(patch) === 0
        ? Number(major) - 1 // `<2.0.0` can only reach 1.x
        : Number(major);
    ceiling = Math.min(ceiling, cap);
  }
  return ceiling;
}

/**
 * Is `range`'s floor at or above `[major, minor, patch]`?
 * @param {string} range
 * @param {[number, number, number]} target
 * @returns {boolean}
 */
export function isAtLeast(range, [major, minor, patch]) {
  const [a, b, c] = floorOf(range);
  if (a !== major) return a > major;
  if (b !== minor) return b > minor;
  return c >= patch;
}

/**
 * Order two `[major, minor, patch]` triples. Negative when `a` is older.
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {number}
 */
function compareTriple(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * Floor of a range that admits anything at all — a fresh triple each call, because
 * callers reassign it.
 * @returns {[number, number, number]}
 */
function noFloor() {
  return [0, 0, 0];
}

/**
 * Lowest version `range` permits, as a triple — the **dual of `ceilingMajorOf`**, and the
 * two must not be confused. `ceilingMajorOf` exists because #1208 asserted a floor when it
 * needed a ceiling (`">=1.1.17"` passed a check while installing 5.0.9). Here the floor
 * genuinely *is* the quantity of interest: the question is whether a range lets somebody
 * run a pnpm too old to read the overrides at all.
 *
 * A disjunction is as loose as its loosest arm, which for a floor is the **lowest** one:
 * `"10.5.1 || 9.0.0"` permits pnpm 9 and must not read as a 10.5.1 floor.
 *
 * **Any term this does not fully understand collapses the whole range to `0.0.0`**, which
 * fails every floor check. An earlier version merely *skipped* such a term, and the
 * adversarial panel found the hole that leaves: `"9.0.0 - 12.0.0"` splits on whitespace
 * into `9.0.0`, `-`, `12.0.0`, the `-` was skipped, and the hyphen range's **upper** bound
 * won the maximum — so a range admitting pnpm 9 reported a floor of 12.0.0 and passed.
 * That is precisely the ceiling-for-floor inversion `ceilingMajorOf` exists to remember
 * (#1208), reappearing inside the fix for it. Skipping is never safe in a floor: it
 * discards evidence that the range is looser than it looks.
 *
 * @param {string} range
 * @returns {[number, number, number]}
 */
export function floorTripleOf(range) {
  const spec = String(range ?? "").trim();
  if (spec === "") return noFloor();
  if (spec.includes("||")) {
    return spec
      .split("||")
      .map(floorTripleOf)
      .reduce((lowest, arm) => (compareTriple(arm, lowest) < 0 ? arm : lowest));
  }

  // The floor is the HIGHEST lower bound among the conjoined terms. A term carrying only
  // an upper bound (`<11.0.0`) does not raise the floor, but — unlike an unreadable term —
  // it is understood, so it does not collapse the range either.
  //
  // Minor and patch are optional so that the ordinary shorthands (`>=11`, `^11`, `>=10.6`)
  // read as the bounds they are. A prerelease or build suffix is deliberately NOT accepted:
  // `10.5.1-beta` sorts BELOW `10.5.1`, so treating it as that floor would overstate it.
  let floor = noFloor();
  for (const term of spec.split(/\s+/)) {
    const match = /^(\^|~|<=|<|>=|>|=)?v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(term);
    if (!match) return noFloor(); // hyphen ranges, `1.x`, prereleases, junk — fail CLOSED
    const [, operator = "", major, minor, patch] = match;
    if (operator === "<" || operator === "<=") continue; // upper bound only
    const candidate = /** @type {[number, number, number]} */ ([
      Number(major),
      Number(minor ?? 0),
      Number(patch ?? 0),
    ]);
    if (compareTriple(candidate, floor) > 0) floor = candidate;
  }
  return floor;
}

/**
 * Does `range` refuse every version below `floor`?
 * @param {string} range
 * @param {readonly [number, number, number]} floor
 * @returns {boolean}
 */
export function rangeMeetsFloor(range, floor) {
  return compareTriple(floorTripleOf(range), /** @type {any} */ (floor)) >= 0;
}

/*
 * There is deliberately NO runtime "which pnpm is running" check here.
 *
 * An earlier draft of this module carried one, reading `npm_config_user_agent`, justified
 * by "`engines` is advisory unless `engine-strict` is set, and this repo has no `.npmrc`".
 * The adversarial panel challenged that premise and it is **false for pnpm** — measured
 * three ways, with no `.npmrc` anywhere:
 *
 *   pnpm 9.15.9 / 10.4.0 / 10.5.0, engines.pnpm ">=10.5.1"  -> ERR_PNPM_UNSUPPORTED_ENGINE,
 *                                                              exit 1, no lockfile written
 *   the same with `.npmrc` `engine-strict=false`            -> ERR_PNPM_UNSUPPORTED_ENGINE
 *   the same with `--config.engine-strict=false`            -> ERR_PNPM_UNSUPPORTED_ENGINE
 *
 * `engine-strict` governs the **node** engine; pnpm enforces its own version from
 * `engines.pnpm` unconditionally and refuses to install. The manifest field is therefore
 * not a wish — it is the enforcement, and it fires earlier and harder than any assertion
 * in a test suite could, before a single package is resolved.
 *
 * A user-agent check on top of that could never fire: by the time tests run, the install
 * it would be warning about has already been refused. Keeping it would have meant shipping
 * unreachable code whose stated reason for existing had been disproved. What remains worth
 * guarding is that nobody LOWERS the field again — a static assertion over `engines.pnpm`,
 * which is what `rangeMeetsFloor` above is for and what the repo suite asserts.
 */

/**
 * Every version of `packageName` that the lockfile actually RESOLVES, including
 * prereleases and four-segment versions.
 *
 * Lifted here from `dependency-audit-1363-advisories.test.mjs`, which had copied it from
 * the #1345 file, which had copied it from #1324. All three carried the same fail-open
 * hole and the copies are now gone: this is the single definition.
 *
 * **The hole (#1363 review, finding 1).** The predecessor matched keys with
 * `/^(\d+\.\d+\.\d+)'?:$/` and `continue`d on anything else. A `packages:` key is not
 * always a bare triple — pnpm writes prerelease (`0.9.11-rc.1:`) and occasionally
 * four-segment keys — and every one of those was silently DROPPED. Dropping is the worst
 * possible failure for an advisory guard: the vulnerable copy is the one that disappears,
 * so the guard goes green *because* the tree is bad. Proven by inserting
 * `'@xmldom/xmldom@0.9.11-rc.1':` — inside the affected band — into the lockfile and
 * watching all 23 arms stay green. A `resolved.length > 0` guard does not save it, because
 * for a multi-copy package the legitimate copies keep the length non-zero.
 *
 * The fix captures the WHOLE key and lets {@link resolvedVersionMeetsFloor} judge it,
 * which throws on anything it cannot parse. Unreadable input now fails CLOSED.
 *
 * Two kinds of line are still excluded, deliberately, and both are matched by shape rather
 * than dropped by silence:
 *   - selector lines (`next@<16.3.3: ^16.3.3`) — text follows the colon
 *   - peer-suffixed snapshot keys (`sharp@0.35.4(@types/node@25.6.0):`) — the bare
 *     counterpart is always present under `packages:` anyway
 *
 * Plain string prefix matching, NOT an interpolated `new RegExp`: a pattern assembled from
 * a parameter is Semgrep's `detect-non-literal-regexp`, and it is also strictly more
 * precise, since the `@` must IMMEDIATELY follow the name.
 *
 * @param {string} lockfileText
 * @param {string} packageName
 * @returns {string[]} resolved versions, unsorted and deduplicated
 */
export function resolvedLockfileVersions(lockfileText, packageName) {
  if (typeof lockfileText !== "string" || typeof packageName !== "string") return [];
  const bare = `  ${packageName}@`;
  const quoted = `  '${packageName}@`;
  const versions = new Set();
  for (const line of lockfileText.split("\n")) {
    let rest;
    if (line.startsWith(bare)) rest = line.slice(bare.length);
    else if (line.startsWith(quoted)) rest = line.slice(quoted.length);
    else continue;
    // Anything up to the terminating (optionally quoted) colon, provided it starts with a
    // digit. The excluded characters are what distinguish a resolved key from a selector
    // line or a peer suffix.
    const match = /^(\d[^:'"\s(]*)'?:$/.exec(rest);
    if (match) versions.add(match[1]);
  }
  return [...versions];
}

/**
 * Does an exact resolved `version` meet `floor`?
 *
 * `isAtLeast` reads the FLOOR of a RANGE and is the right tool for an override target. It
 * is the wrong tool here: `floorOf` takes the first version-shaped substring it finds —
 * fine for `^16.3.3`, but it silently accepts anything. A resolved version is exact, so it
 * is compared as one, and anything unparseable THROWS rather than reading as 0.0.0 or as a
 * pass.
 *
 * Prerelease handling follows semver: `1.2.3-rc.1` sorts BELOW `1.2.3`, so it does not
 * meet a floor of `1.2.3`. That is the whole point of the #1363 fix — an `-rc` build
 * inside an affected band must be caught, not waved through. A build suffix (`+meta`) and
 * a fourth segment both sort at or above the triple, so they pass.
 *
 * @param {string} version
 * @param {readonly [number, number, number]} floor
 * @returns {boolean}
 * @throws {Error} when `version` is not an exact resolved version
 */
export function resolvedVersionMeetsFloor(version, floor) {
  const match = /^(\d+)\.(\d+)\.(\d+)([-+.][0-9A-Za-z.+-]*)?$/.exec(String(version ?? ""));
  if (!match) throw new Error(`not an exact resolved version: ${version}`);
  const triple = [Number(match[1]), Number(match[2]), Number(match[3])];
  for (let i = 0; i < 3; i++) {
    if (triple[i] !== floor[i]) return triple[i] > floor[i];
  }
  const suffix = match[4];
  return !(suffix !== undefined && suffix.startsWith("-"));
}
