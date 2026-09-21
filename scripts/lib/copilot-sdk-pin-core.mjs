/**
 * Pure decision logic for the **single-version pin** invariant (Issue #1347).
 *
 * ## Why this exists
 *
 * METIS runs the GitHub Copilot SDK on two paths: in-process in `server/`, and out of
 * process in the `server/copilot-svc` sidecar. `server/copilot-svc/src/sessions.ts` states
 * the contract between them in a comment —
 *
 * > *"Subset of the `@github/copilot-sdk` `CopilotSession` surface that the sidecar relies
 * > on. Mirrors `CopilotSessionLike` in the main server's `copilot-wrapper.ts` so the
 * > contract stays in lock-step."*
 *
 * — and nothing enforced it. The pins had already drifted underneath that sentence:
 * `server/package.json` asked for `^0.2.2` and the sidecar for `^0.3.0`, and
 * `pnpm-lock.yaml` resolved **both**. Two real installs, so "the two Copilot paths" were
 * not the same code.
 *
 * Nothing in the suite could see it. METIS declares its own *structural*
 * `CopilotClientLike` / `CopilotSessionLike` interfaces with `createSession(config: any)`,
 * and every unit test stubs those interfaces rather than the SDK, so `tsc` and `pnpm test`
 * both stay green straight through an SDK swap that has broken at runtime. A behavioural
 * difference between the two versions would surface as a bug reproducible on one Copilot
 * path and not the other, with no test able to name the cause.
 *
 * This module is the check that replaces the prose. It asserts, from the two artefacts
 * pnpm itself reads:
 *
 *  1. **Every workspace manifest that declares the package declares the same range.**
 *  2. **The lockfile resolves exactly one version** — the AC's own test, by resolution
 *     rather than by manifest, because two carets can agree on paper and still resolve
 *     apart.
 *  3. **That one resolution satisfies the declared range**, so a hand-edited lockfile
 *     cannot converge the tree onto a version no manifest asked for.
 *
 * ### What it deliberately does not claim
 *
 * It is a *pin* gate, not a *behaviour* gate. It cannot show the two paths behave alike at
 * runtime — that blindness is #1121's, and closing it means replacing the structural
 * interfaces with the SDK's own types, which is what makes the sidecar possible in the
 * first place. It also does not check the interface-mirror half of the comment above; two
 * hand-written structural subsets in different packages have no artefact to compare that
 * would not be either trivially satisfiable or impossible, and this repo has shipped a long
 * line of gates that could not fail (#1168, #1215, #1249, #1270, #1277).
 *
 * ### The fail-open guard
 *
 * `minimumDeclarations` exists because "nobody declares it" is internally consistent with
 * every other assertion here: zero declarations means one range (vacuously), and deleting
 * the dependency from one manifest would leave one declaration and a green gate. That is
 * the exact shape of #1168 — *a default that means "nothing to check"*. So the count is
 * asserted as its own axis: **identity, not just content**.
 *
 * Everything here is pure — callers inject file contents, so every branch is unit-testable
 * without a repository.
 */

/** The package this gate exists for. Callers may pass another; this is the live one. */
export const COPILOT_SDK_PACKAGE = "@github/copilot-sdk";

/**
 * How many workspace manifests must declare the package before the audit means anything.
 *
 * Two: `server/package.json` and `server/copilot-svc/package.json`. There is no headroom
 * in this number on purpose — unlike a count of security overrides, which legitimately
 * ebbs as advisories die, a Copilot path is either present or it has been deleted, and
 * deleting one is exactly the event that must not pass silently.
 */
export const MINIMUM_DECLARATIONS = 2;

/** Manifest fields pnpm resolves a dependency range from. */
export const DEPENDENCY_FIELDS = Object.freeze([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
]);

/**
 * Characters that end a version token in a pnpm lockfile key (`'@pkg@1.2.3':`).
 *
 * This is the character class the acceptance criterion's own
 * `grep -oE "@github/copilot-sdk@[0-9.]+"` implies, spelled out so the scan below needs no
 * regex built from a variable — see `resolvedVersions`.
 */
const VERSION_TERMINATORS = new Set(["'", '"', ":", " ", "\t", "\n", "\r", ",", "(", ")"]);

/**
 * Every workspace manifest that declares `packageName`, with the range and the field it
 * came from. Manifests that are not valid JSON are reported rather than skipped — an
 * unreadable manifest is a failure, not an absence.
 *
 * @param {Array<{ path: string, text: string }>} manifests
 * @param {string} packageName
 * @returns {{
 *   declarations: Array<{ path: string, field: string, range: string }>,
 *   unreadable: string[],
 * }}
 */
export function collectDeclarations(manifests, packageName) {
  /** @type {Array<{ path: string, field: string, range: string }>} */
  const declarations = [];
  /** @type {string[]} */
  const unreadable = [];

  for (const manifest of manifests ?? []) {
    let parsed;
    try {
      parsed = JSON.parse(manifest.text);
    } catch {
      unreadable.push(manifest.path);
      continue;
    }
    if (parsed === null || typeof parsed !== "object") {
      unreadable.push(manifest.path);
      continue;
    }
    for (const field of DEPENDENCY_FIELDS) {
      const block = parsed[field];
      if (block === null || typeof block !== "object") continue;
      const range = block[packageName];
      if (typeof range !== "string") continue;
      declarations.push({ path: manifest.path, field, range });
    }
  }

  return { declarations, unreadable };
}

/**
 * Distinct versions `packageName` resolves to in the lockfile, sorted.
 *
 * Reads the lockfile's own `<name>@<version>` keys — the `packages:` and `snapshots:`
 * sections — which is what the acceptance criterion's
 * `grep -oE "@github/copilot-sdk@[0-9.]+" pnpm-lock.yaml | sort -u` reads. Deliberately
 * *not* the importers' `specifier:` lines: those restate the manifests, and the whole
 * point is to check resolution independently of what the manifests asked for.
 *
 * @param {string} lockfileText
 * @param {string} packageName
 * @returns {string[]}
 */
export function resolvedVersions(lockfileText, packageName) {
  if (typeof lockfileText !== "string") return [];

  // Plain string scanning, NOT `new RegExp(packageName + ...)`. A regex assembled from a
  // parameter is Semgrep's `detect-non-literal-regexp` (ReDoS) and it blocked this file in
  // CI; escaping the name would have satisfied the reviewer in the diff and still left a
  // dynamic pattern compiled against a ~570 KB file. Scanning is also strictly more
  // precise: the separator must IMMEDIATELY follow the name, so `@github/copilot` cannot
  // match `@github/copilot-sdk@0.3.0` and vice versa — a real pair in this tree.
  const needle = `${packageName}@`;
  const found = new Set();
  for (
    let at = lockfileText.indexOf(needle);
    at !== -1;
    at = lockfileText.indexOf(needle, at + 1)
  ) {
    const start = at + needle.length;
    let end = start;
    while (end < lockfileText.length && !VERSION_TERMINATORS.has(lockfileText[end])) end++;
    const version = lockfileText.slice(start, end);
    // A leading digit is what separates a version from a peer-suffixed alias or prose.
    if (version !== "" && version[0] >= "0" && version[0] <= "9") found.add(version);
  }
  return [...found].sort();
}

/**
 * Split `1.2.3` into numbers; `null` when it is not a plain three-part version.
 *
 * @param {string | undefined} version
 * @returns {[number, number, number] | null}
 */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version ?? "");
  return match
    ? /** @type {[number, number, number]} */ ([
        Number(match[1]),
        Number(match[2]),
        Number(match[3]),
      ])
    : null;
}

/**
 * Lexicographic compare of two `[major, minor, patch]` triples.
 *
 * @param {[number, number, number]} a
 * @param {[number, number, number]} b
 * @returns {-1 | 0 | 1}
 */
function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy `range`, for the narrow range vocabulary this repo pins with?
 *
 * `^`, `~` and an exact version are understood. **Anything else fails closed** — it
 * returns `null`, which the audit reports as `unsupported-range` rather than treating as
 * satisfied. A gate that silently passes ranges it cannot parse is a gate that stops
 * checking the day somebody writes `>=0.3.0`.
 *
 * `^0.3.0` is `>=0.3.0 <0.4.0`, not `<1.0.0`: npm's caret pins the leftmost non-zero
 * component, which for a 0.x package is the minor. That is the whole reason `^0.2.2` and
 * `^0.3.0` could not converge on their own.
 *
 * @param {string} range
 * @param {string} version
 * @returns {boolean | null} `null` when the range vocabulary is not understood
 */
export function satisfiesRange(range, version) {
  const target = parseVersion(version);
  if (target === null) return null;
  if (typeof range !== "string") return null;

  const trimmed = range.trim();
  const operator = trimmed.startsWith("^") ? "^" : trimmed.startsWith("~") ? "~" : "";
  const floor = parseVersion(operator === "" ? trimmed : trimmed.slice(1));
  if (floor === null) return null;

  if (compareTriples(target, floor) < 0) return false;
  if (operator === "") return compareTriples(target, floor) === 0;

  const [major, minor] = floor;
  // `~` always bounds at the next minor. `^` bounds at the next major, except on the
  // 0.x line where npm treats the minor as the breaking axis.
  const ceiling = /** @type {[number, number, number]} */ (
    operator === "~" || major === 0 ? [major, minor + 1, 0] : [major + 1, 0, 0]
  );
  return compareTriples(target, ceiling) < 0;
}

/**
 * Audit the pin. Returns a `problems` list rather than throwing, so a caller can report
 * every fault in one run instead of one per fix cycle.
 *
 * @param {object} input
 * @param {Array<{ path: string, text: string }>} input.manifests
 * @param {string} input.lockfileText
 * @param {string} [input.packageName]
 * @param {number} [input.minimumDeclarations]
 * @returns {{
 *   problems: Array<{ kind: string, message: string }>,
 *   declarations: Array<{ path: string, field: string, range: string }>,
 *   ranges: string[],
 *   resolved: string[],
 * }}
 */
export function auditSingleVersionPin({
  manifests,
  lockfileText,
  packageName = COPILOT_SDK_PACKAGE,
  minimumDeclarations = MINIMUM_DECLARATIONS,
}) {
  /** @type {Array<{ kind: string, message: string }>} */
  const problems = [];

  const { declarations, unreadable } = collectDeclarations(manifests, packageName);
  for (const path of unreadable) {
    problems.push({
      kind: "unreadable-manifest",
      message: `${path} is not readable JSON, so it cannot be checked for ${packageName}`,
    });
  }

  if (declarations.length < minimumDeclarations) {
    problems.push({
      kind: "too-few-declarations",
      message:
        `${declarations.length} workspace manifest(s) declare ${packageName}, expected at ` +
        `least ${minimumDeclarations}. Deleting a Copilot path is not a way to satisfy ` +
        `this gate — if a path really went away, lower MINIMUM_DECLARATIONS deliberately ` +
        `(#1347).`,
    });
  }

  const ranges = [...new Set(declarations.map((d) => d.range))].sort();
  if (ranges.length > 1) {
    problems.push({
      kind: "pin-drift",
      message:
        `${packageName} is pinned ${ranges.length} different ways: ` +
        declarations.map((d) => `${d.path} (${d.field}) ${d.range}`).join(", ") +
        `. The in-process and sidecar Copilot paths must run the same SDK (#1347).`,
    });
  }

  const resolved = resolvedVersions(lockfileText, packageName);
  if (resolved.length === 0) {
    problems.push({
      kind: "no-resolution",
      message:
        `pnpm-lock.yaml resolves no version of ${packageName}, so nothing here was ` +
        `actually verified against the installed tree`,
    });
  } else if (resolved.length > 1) {
    problems.push({
      kind: "multiple-resolutions",
      message:
        `pnpm-lock.yaml resolves ${resolved.length} versions of ${packageName} ` +
        `(${resolved.join(", ")}); exactly one is required`,
    });
  }

  // Resolution-vs-range is checked per declaration so an unsatisfied pin names its own
  // manifest, and so it still reports when the ranges have drifted.
  for (const version of resolved) {
    for (const declaration of declarations) {
      const ok = satisfiesRange(declaration.range, version);
      if (ok === null) {
        problems.push({
          kind: "unsupported-range",
          message:
            `${declaration.path} pins ${packageName} as "${declaration.range}", which this ` +
            `gate cannot evaluate (it understands "^", "~" and exact versions). Extend ` +
            `satisfiesRange rather than leaving the range unchecked.`,
        });
      } else if (!ok) {
        problems.push({
          kind: "resolution-outside-range",
          message:
            `pnpm-lock.yaml resolves ${packageName}@${version}, which does not satisfy ` +
            `"${declaration.range}" declared in ${declaration.path}`,
        });
      }
    }
  }

  return { problems, declarations, ranges, resolved };
}
