/**
 * Compute whether the current branch needs the adversarial panel, from git, failing closed
 * (#1476).
 *
 * The SKILL.md one-liner this replaces piped `git diff` into `node -e`. Every way git could fail
 * reached the gate as `{ required: false }` with exit 0, which looks exactly like a clean
 * answer. The ways were: an unknown or unfetched base ref, a shallow clone with no merge base,
 * a dropped pipe or empty stdin, a forced `color.diff=always`, and an external diff driver.
 * This module runs git itself through `execFileSync` (no shell), pins every diff option that
 * config can override, and **throws** on anything it cannot vouch for:
 *
 *   - the base or head does not resolve to a commit (`git rev-parse --verify`);
 *   - the two have no merge base;
 *   - paths changed but the diff text is empty;
 *   - the paths read out of the diff differ from `git diff --name-only` over the same range,
 *     which catches any diff text this parser cannot read, whatever made it unreadable.
 *
 * Changed paths and added imports both come from that one verified diff.
 */

import { execFileSync } from "node:child_process";

import {
  addedImportSpecifiers,
  changedPathsFromDiff,
  shouldRunAdversarialPass,
} from "./adversarial-tally-core.mjs";

/** A failure to compute the answer, as opposed to a computed `required: false`. */
export class AdversarialRequiredError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AdversarialRequiredError";
  }
}

/**
 * Options that pin the diff's format against repository and user config: colour, external
 * drivers, textconv filters, `diff.noprefix` / `diff.mnemonicPrefix`, `diff.relative`, and rename
 * detection (off, so a moved file reads as delete + add and both paths are gated).
 */
export const DIFF_FORMAT_FLAGS = Object.freeze([
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--no-relative",
  "--no-renames",
]);

/**
 * @typedef {(args: string[]) => string} GitRunner runs `git <args>` and returns stdout, or
 *   throws with git's stderr in the message
 */

/**
 * @param {string} cwd
 * @returns {GitRunner}
 */
export function execGit(cwd) {
  return (args) => {
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        maxBuffer: 512 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const e = /** @type {{ stderr?: string | Buffer, message?: string }} */ (error);
      const stderr = String(e.stderr ?? "").trim();
      throw new AdversarialRequiredError(
        `\`git ${args.join(" ")}\` failed: ${stderr || e.message || "unknown error"}`,
      );
    }
  };
}

/**
 * @param {GitRunner} git
 * @param {string} ref
 * @param {string} role
 * @returns {string} the commit SHA
 */
function resolveCommit(git, ref, role) {
  try {
    return git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
  } catch {
    throw new AdversarialRequiredError(
      `${role} ref \`${ref}\` does not resolve to a commit. In a shallow or single-branch clone, ` +
        `run \`git fetch origin main\` first, or pass --base <sha>. No answer was computed, so do ` +
        `not treat this as "no panel required".`,
    );
  }
}

/**
 * @param {{
 *   git: GitRunner,
 *   base?: string,
 *   head?: string,
 *   title?: string,
 *   labels?: string[],
 * }} options
 * @returns {{ required: boolean, reasons: string[], base: string, mergeBase: string,
 *   head: string, changedPaths: string[], addedImports: string[] }}
 */
export function computeAdversarialRequirement({
  git,
  base = "origin/main",
  head = "HEAD",
  title = "",
  labels = [],
}) {
  const baseSha = resolveCommit(git, base, "base");
  const headSha = resolveCommit(git, head, "head");

  let mergeBase;
  try {
    mergeBase = git(["merge-base", baseSha, headSha]).trim();
  } catch {
    mergeBase = "";
  }
  if (!mergeBase) {
    throw new AdversarialRequiredError(
      `\`${base}\` and \`${head}\` have no merge base — usually a shallow clone. Run ` +
        "`git fetch --unshallow` (or `git fetch --deepen=<n>`) and retry.",
    );
  }

  const changedPaths = git([
    "diff",
    "--name-only",
    "-z",
    "--no-relative",
    "--no-renames",
    "--no-ext-diff",
    mergeBase,
    headSha,
    "--",
  ])
    .split("\0")
    .filter(Boolean);
  const diff = git(["diff", ...DIFF_FORMAT_FLAGS, mergeBase, headSha, "--"]);

  if (changedPaths.length > 0 && diff.trim() === "") {
    throw new AdversarialRequiredError(
      `${changedPaths.length} path(s) changed between ${mergeBase.slice(0, 12)} and ` +
        `${headSha.slice(0, 12)} but the diff came back empty, so no import could be read.`,
    );
  }

  const parsed = new Set(changedPathsFromDiff(diff));
  const unread = changedPaths.filter((p) => !parsed.has(p));
  if (unread.length > 0) {
    throw new AdversarialRequiredError(
      `the diff could not be parsed for ${unread.length} of ${changedPaths.length} changed ` +
        `path(s), e.g. \`${unread[0]}\`. Something rewrote git's diff output (colour, a diff ` +
        "driver, a pager); refusing to report imports from a diff that was not read.",
    );
  }

  const addedImports = addedImportSpecifiers(diff);
  const { required, reasons } = shouldRunAdversarialPass({
    changedPaths,
    labels,
    title,
    addedImports,
  });
  return { required, reasons, base: baseSha, mergeBase, head: headSha, changedPaths, addedImports };
}
