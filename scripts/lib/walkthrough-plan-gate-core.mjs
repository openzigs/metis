/**
 * #948 — a PR that adds or removes a UI page or a server route changes what the
 * walkthrough can exercise, so it must either update
 * `docs/walkthroughs/TEST_PLAN.md` or say, with the `no-walkthrough-impact`
 * label, that the walkthrough is unaffected.
 *
 * Pure logic only; `scripts/verify-walkthrough-plan.mjs` gathers the diff and
 * the labels. Modelled on `changelog-fragments-core.mjs`.
 *
 * ## What triggers the requirement
 *
 *  - **A page added, removed or renamed** under `ui/src/app/**` — a `page.tsx`
 *    (or `.ts`/`.jsx`/`.js`). Editing a page that stays put does not trigger:
 *    the walkthrough still reaches it, and requiring a plan edit for every UI
 *    tweak would make the label the normal path and the gate noise.
 *  - **A route registration added or removed** in `server/src/routes/**`
 *    (tests excluded): per file, the `(method, path)` pairs on the removed
 *    lines differ from those on the added lines. A pair comes from a line that
 *    registers a path (`r.get("/x"`), a mount (`r.use("/x", …, fooRouter())`,
 *    keyed by prefix and target), or a bare path literal on its own line — the
 *    second line of a multi-line `r.post(\n  "/x",` call. A bare path line
 *    counts only straight after a line that opens a registration call, and only
 *    when its literal holds path characters (no spaces), so a slash-leading
 *    error message is not a route. Comment lines (`//`, `/*`, `*`) never count,
 *    even when they quote a registration. Editing a registration in place (new
 *    middleware, a renamed handler) leaves the pairs unchanged and does not
 *    trigger; a rename shows as one of each, so it does. The runner diffs with
 *    `-U1` so the opening line of a multi-line call arrives as context when
 *    only its path changed. Known blind spot: changing only the method on an
 *    `r.post(` line whose path sits on the next, unchanged line is not seen.
 *
 * ## Exemptions
 *
 *  - Dependabot: it cannot edit the plan or set a label, and it never adds a
 *    route. Same author list as the changelog gate.
 *  - A docs-only PR: it cannot change what the product serves.
 */

import { isAutomatedDependencyAuthor } from "./changelog-fragments-core.mjs";

export const TEST_PLAN_PATH = "docs/walkthroughs/TEST_PLAN.md";
export const WAIVER_LABEL = "no-walkthrough-impact";

const PAGE_RE = /^ui\/src\/app\/(?:.+\/)?page\.(?:tsx|ts|jsx|js)$/;
const ROUTE_SOURCE_RE = /^server\/src\/routes\/.+\.ts$/;
const TEST_SOURCE_RE = /\.test\.ts$/;

/** A route registration or mount on one line: `x.get("/path"`, `x.use("/path",`. */
const REGISTRATION_LINE_RE = /\.\s*(?:get|post|put|patch|delete|all|use)\(\s*(["'`])\/[^"'`]*\1/;

/**
 * A path literal alone on its line: the second line of a multi-line
 * registration. Path characters only — a literal with a space is prose.
 */
const BARE_PATH_LINE_RE = /^\s*(["'`])\/[\w\-.:/*?{}+~@]*\1\s*,?\s*$/;

/** A comment line: `// …`, `/* …`, or a ` * …` continuation. */
const COMMENT_LINE_RE = /^\s*(?:\/\/|\/\*|\*)/;

/** @param {string} path @returns {boolean} */
export function isPagePath(path) {
  return PAGE_RE.test(path);
}

/** @param {string} path @returns {boolean} */
export function isRouteSourcePath(path) {
  return ROUTE_SOURCE_RE.test(path) && !TEST_SOURCE_RE.test(path);
}

/**
 * Docs that cannot change what the product serves.
 *
 * @param {string} path
 * @returns {boolean}
 */
export function isDocsPath(path) {
  return path.startsWith("docs/") || path.startsWith(".changes/") || /\.md$/i.test(path);
}

/**
 * Parse `git diff --name-status -M` output.
 *
 * @param {string} text
 * @returns {{ status: string, path: string, from?: string }[]}
 */
export function parseNameStatus(text) {
  /** @type {{ status: string, path: string, from?: string }[]} */
  const changes = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    const [code, first, second] = line.split("\t");
    const status = code.charAt(0);
    if ((status === "R" || status === "C") && second !== undefined) {
      changes.push({ status, path: second, from: first });
    } else {
      changes.push({ status, path: first });
    }
  }
  return changes;
}

/** A registration or mount whose path is on the next line: `r.post(` alone. */
const OPEN_CALL_LINE_RE = /\.\s*(get|post|put|patch|delete|all|use)\(\s*$/;

/** The method and path a registration line names. */
const REGISTRATION_KEY_RE = /\.\s*(get|post|put|patch|delete|all|use)\(\s*(["'`])(\/[^"'`]*)\2/;

/** The last argument of a one-line mount: `subRouter` in `r.use("/x", auth, subRouter());`. */
const MOUNT_TARGET_RE = /,\s*([A-Za-z_$][\w$.]*)\s*(?:\([^()]*\))?\s*\)\s*;?\s*$/;

/**
 * What a route line registers, as a comparable key: `GET /x`, or
 * `USE /x → fooRouter` for a mount — its target is part of its identity, since
 * swapping the router changes every route under the prefix. A bare path line
 * takes its method from an open call (`r.post(`) on the line before it on the
 * same diff side, and registers nothing without one.
 *
 * @param {string} body the line without its diff sign
 * @param {string | null} pendingMethod the method of an open call on the previous line
 * @returns {string | null} null when the line registers nothing
 */
export function routeKey(body, pendingMethod) {
  if (COMMENT_LINE_RE.test(body)) return null;
  const reg = REGISTRATION_KEY_RE.exec(body);
  if (reg) {
    const method = reg[1].toUpperCase();
    if (method !== "USE") return `${method} ${reg[3]}`;
    const target = MOUNT_TARGET_RE.exec(body.slice(reg.index + reg[0].length));
    return `USE ${reg[3]} → ${target ? target[1] : "?"}`;
  }
  if (pendingMethod !== null && BARE_PATH_LINE_RE.test(body)) {
    const path = body.trim().replace(/,\s*$/, "").slice(1, -1);
    return `${pendingMethod} ${path}`;
  }
  return null;
}

/**
 * The method of a registration call left open at the end of this line
 * (`r.post(`), or null — including for a comment that quotes one.
 *
 * @param {string} body
 * @returns {string | null}
 */
function openCallMethod(body) {
  if (COMMENT_LINE_RE.test(body)) return null;
  const open = OPEN_CALL_LINE_RE.exec(body);
  return open ? open[1].toUpperCase() : null;
}

/**
 * Route lines added or removed in a unified diff, per route source file.
 *
 * File names come only from a `diff --git` line and the `---`/`+++` lines in
 * the header block right after it, before the first `@@`. With `-U0`, a
 * removed content line that reads `-- x` arrives as `--- x`, so a `---` or
 * `+++` anywhere else is content, not a new file.
 *
 * @param {string} diffText output of `git diff -U1 <base>...HEAD -- server/src/routes`
 *   (or `-U0`); a context line only supplies the open call that a changed bare
 *   path line follows
 * @returns {{ file: string, sign: "+" | "-", line: string, key: string }[]}
 */
export function routeLineChanges(diffText) {
  /** @type {{ file: string, sign: "+" | "-", line: string, key: string }[]} */
  const changes = [];
  /** @type {string | null} */
  let file = null;
  /** @type {string | null} */
  let oldFile = null;
  let inHeader = false;
  /** @type {{ "+": string | null, "-": string | null }} */
  let pending = { "+": null, "-": null };
  for (const line of diffText.split("\n")) {
    const gitHeader = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (gitHeader) {
      inHeader = true;
      oldFile = gitHeader[1];
      file = gitHeader[2];
      pending = { "+": null, "-": null };
      continue;
    }
    if (inHeader) {
      if (line.startsWith("--- ")) {
        const old = line.slice(4).replace(/^a\//, "");
        if (old !== "/dev/null") oldFile = old;
      } else if (line.startsWith("+++ ")) {
        const next = line.slice(4).replace(/^b\//, "");
        // A deleted file's new side is /dev/null; its routes still went away.
        file = next === "/dev/null" ? oldFile : next;
      } else if (line.startsWith("@@")) {
        inHeader = false;
      }
      continue;
    }
    if (file === null || !isRouteSourcePath(file)) continue;
    const sign = line.charAt(0);
    if (sign === " ") {
      // A context line is on both sides: it registers nothing new, but it may
      // open the call whose path the next, changed line holds.
      const method = openCallMethod(line.slice(1));
      pending = { "+": method, "-": method };
      continue;
    }
    if (sign !== "+" && sign !== "-") {
      pending = { "+": null, "-": null };
      continue;
    }
    const body = line.slice(1);
    const key =
      REGISTRATION_LINE_RE.test(body) || BARE_PATH_LINE_RE.test(body)
        ? routeKey(body, pending[sign])
        : null;
    pending[sign] = openCallMethod(body);
    if (key !== null) changes.push({ file, sign, line: body.trim(), key });
  }
  return changes;
}

/**
 * The route lines whose registration actually came or went. Per file, the
 * multiset of keys on the removed side is compared with the added side and
 * only the difference survives: editing a registration in place — new
 * middleware, a renamed handler — removes and re-adds the same key, so it nets
 * to nothing, while a rename (`/old` → `/new`) leaves one of each.
 *
 * @param {{ file: string, sign: "+" | "-", line: string, key: string }[]} lineChanges
 * @returns {{ file: string, sign: "+" | "-", line: string, key: string }[]}
 */
export function netRouteChanges(lineChanges) {
  /** @type {Map<string, number>} */
  const balance = new Map();
  const idOf = (/** @type {{ file: string, key: string }} */ c) => `${c.file}\u0000${c.key}`;
  for (const c of lineChanges) {
    balance.set(idOf(c), (balance.get(idOf(c)) ?? 0) + (c.sign === "+" ? 1 : -1));
  }
  /** @type {{ file: string, sign: "+" | "-", line: string, key: string }[]} */
  const net = [];
  for (const c of lineChanges) {
    const left = balance.get(idOf(c)) ?? 0;
    if (left > 0 && c.sign === "+") {
      net.push(c);
      balance.set(idOf(c), left - 1);
    } else if (left < 0 && c.sign === "-") {
      net.push(c);
      balance.set(idOf(c), left + 1);
    }
  }
  return net;
}

/**
 * Decide whether this PR owes a test-plan update, and whether it paid.
 *
 * @param {{
 *   changes: { status: string, path: string, from?: string }[],
 *   routeChanges: { file: string, sign: "+" | "-", line: string, key: string }[],
 *   labels: string[],
 *   author: string | null,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   triggers: string[],
 *   verdict: "not-required" | "exempt-author" | "exempt-docs" | "plan-updated" | "label" | "missing",
 * }}
 */
export function evaluateWalkthroughPlanGate({ changes, routeChanges, labels, author }) {
  /** @type {string[]} */
  const triggers = [];
  for (const change of changes) {
    if (change.status === "A" && isPagePath(change.path)) {
      triggers.push(`page added: ${change.path}`);
    } else if (change.status === "D" && isPagePath(change.path)) {
      triggers.push(`page removed: ${change.path}`);
    } else if (
      (change.status === "R" || change.status === "C") &&
      (isPagePath(change.path) || (change.from !== undefined && isPagePath(change.from)))
    ) {
      triggers.push(`page moved: ${change.from} → ${change.path}`);
    }
  }
  for (const route of netRouteChanges(routeChanges)) {
    triggers.push(
      `route ${route.sign === "+" ? "added" : "removed"} in ${route.file}: ${route.line}`,
    );
  }

  if (isAutomatedDependencyAuthor(author)) {
    return { ok: true, triggers, verdict: "exempt-author" };
  }
  if (changes.length > 0 && changes.every((c) => isDocsPath(c.path))) {
    return { ok: true, triggers, verdict: "exempt-docs" };
  }
  if (triggers.length === 0) return { ok: true, triggers, verdict: "not-required" };
  if (changes.some((c) => c.path === TEST_PLAN_PATH)) {
    return { ok: true, triggers, verdict: "plan-updated" };
  }
  if (labels.includes(WAIVER_LABEL)) return { ok: true, triggers, verdict: "label" };
  return { ok: false, triggers, verdict: "missing" };
}
