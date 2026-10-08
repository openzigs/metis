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
 *    (tests excluded): a changed line that registers a path
 *    (`r.get("/x"`, `r.use("/x", …)`) or is a bare path literal on its own
 *    line — the second line of a multi-line `r.post(\n  "/x",` call. A rename
 *    shows as one of each, so it triggers too.
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

/** A path literal alone on its line: the second line of a multi-line registration. */
const BARE_PATH_LINE_RE = /^\s*(["'`])\/[^"'`]*\1\s*,?\s*$/;

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

/**
 * Route lines added or removed in a unified diff, per route source file.
 *
 * @param {string} diffText output of `git diff -U0 <base>...HEAD -- server/src/routes`
 * @returns {{ file: string, sign: "+" | "-", line: string }[]}
 */
export function routeLineChanges(diffText) {
  /** @type {{ file: string, sign: "+" | "-", line: string }[]} */
  const changes = [];
  /** @type {string | null} */
  let file = null;
  /** @type {string | null} */
  let oldFile = null;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("--- ")) {
      oldFile = line.slice(4).replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const newFile = line.slice(4).replace(/^b\//, "");
      // A deleted file's new side is /dev/null; its routes still went away.
      file = newFile === "/dev/null" ? oldFile : newFile;
      continue;
    }
    if (file === null || !isRouteSourcePath(file)) continue;
    const sign = line.charAt(0);
    if (sign !== "+" && sign !== "-") continue;
    const body = line.slice(1);
    if (REGISTRATION_LINE_RE.test(body) || BARE_PATH_LINE_RE.test(body)) {
      changes.push({ file, sign, line: body.trim() });
    }
  }
  return changes;
}

/**
 * Decide whether this PR owes a test-plan update, and whether it paid.
 *
 * @param {{
 *   changes: { status: string, path: string, from?: string }[],
 *   routeChanges: { file: string, sign: "+" | "-", line: string }[],
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
  for (const route of routeChanges) {
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
