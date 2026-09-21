/**
 * Anchor a tree-scanning gate to the repository root, and decide what it does when
 * there is no repository (#1381).
 *
 * ## Why this exists at all
 *
 * `git ls-files` enumerates the CURRENT DIRECTORY's subtree, not the repository. A gate
 * built on it inherits whatever working directory its caller happened to have, and then
 * reports success about the part of the tree it reached. Measured on `main` @ 2ebdfcaf,
 * before this module:
 *
 *   $ node scripts/lib/check-no-nul.mjs          -> 4363 tracked text files scanned
 *   $ cd server && node ../scripts/lib/check-no-nul.mjs -> 2363 tracked text files scanned
 *
 * Two thousand files unscanned and the success line identical in tone. `pnpm lint` runs
 * at the root, so CI never saw it; a developer iterating inside `server/` — precisely
 * when the gate is most wanted — saw a green gate over half a tree.
 *
 * #1380 fixed this in `verify-no-company-identifiers.mjs` with a private helper. Two
 * private copies is how the two gates drift apart, so the anchor and the no-repository
 * policy live here once and both gates call it. The issue asks for the two to AGREE;
 * sharing the implementation is the only version of agreement that cannot rot.
 *
 * ## The no-repository decision, and why it is "fail", not "skip"
 *
 * Both gates used to throw a raw Node stack trace outside a checkout — an exported
 * source tarball has no `.git`, so `pnpm lint` crashed rather than explained. That is
 * not a deliberate behaviour, so #1381 asks for one. The two candidates:
 *
 *   skip, exit 0 — reads as a pass. The gate would print "nothing to do" for a tree it
 *                  never enumerated, in a repository that has shipped that exact shape
 *                  seven times (#1215, #1270, and this issue).
 *   fail, exit 1 — the tracked-file set is not empty outside a checkout, it is UNKNOWN.
 *
 * `check-no-nul.mjs` already settled this question one scale down: a tracked file it
 * cannot open is "UNKNOWN, not clean" and fails the gate (#1215). A whole tree it cannot
 * enumerate is the same question about every file at once, so the same answer applies,
 * and the two gates are consistent with each other AND with the rule already in one of
 * them. The cost is bounded and was measured, not assumed: no Dockerfile and no CI job
 * in this repository runs `pnpm lint` outside a checkout (`.dockerignore` excludes
 * `.git`, but no image build lints), so nothing that runs today changes behaviour.
 *
 * What changes is the failure's shape: a one-paragraph explanation naming the cause and
 * the fix, instead of an `execFileSync` stack trace.
 */
import { execFileSync } from "node:child_process";

/**
 * Ask git where the repository root is.
 *
 * `stdio` pipes stderr so git's own diagnosis can be quoted back rather than leaking to
 * the terminal ahead of our message, and ignores stdin so a gate spawned with an open
 * pipe can never block here.
 *
 * @returns {string} absolute path to the repository root
 */
function gitToplevel() {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/**
 * The one line git printed, or a description of why git itself could not run.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function gitDiagnosis(error) {
  const err = /** @type {NodeJS.ErrnoException & { stderr?: Buffer | string }} */ (error);
  if (err?.code === "ENOENT") return "the `git` executable was not found on PATH";
  const stderr = err?.stderr ? String(err.stderr).trim() : "";
  if (stderr) return stderr.split("\n")[0];
  return err?.message ? String(err.message).split("\n")[0] : "git failed for an unknown reason";
}

/**
 * The message a gate prints when it cannot find a repository to scan.
 *
 * Pure and exported so its wording is pinned by a test: the whole point of #1381 is that
 * a gate's OUTPUT is what a human reads, and "identical in tone to a pass" is the defect.
 *
 * @param {string} gate name the gate prints itself under, e.g. "check-no-nul"
 * @param {unknown} error whatever `git rev-parse` threw
 * @returns {string}
 */
export function notACheckoutMessage(gate, error) {
  return [
    `${gate}: not a git checkout — NOTHING was scanned.`,
    "",
    "This gate's scope is every file git tracks. Outside a repository that set is not",
    "empty, it is UNKNOWN — and unknown is not clean (#1215). Exiting 0 here would print",
    "a pass about a tree the gate never enumerated, which is the same untruth #1381 fixed",
    "for a subdirectory invocation.",
    "",
    "Run it from inside a clone. An exported tree with no git metadata has no tracked-file",
    "set, so these gates cannot answer for it and should not be run over it.",
    "",
    `git said: ${gitDiagnosis(error)}`,
  ].join("\n");
}

/**
 * Resolve the repository root without touching the process.
 *
 * @param {object} [options]
 * @param {string} [options.gate] gate name used in the failure message
 * @param {() => string} [options.toplevel] injected for tests
 * @returns {{ ok: true, root: string } | { ok: false, message: string }}
 */
export function resolveRepoRoot({ gate = "gate", toplevel = gitToplevel } = {}) {
  let root;
  try {
    root = toplevel();
  } catch (error) {
    return { ok: false, message: notACheckoutMessage(gate, error) };
  }
  // `git rev-parse` exiting 0 with no path is not a state git produces today, but an
  // empty string would `chdir` to nowhere and be read as success. Treated as the same
  // unknown rather than trusted.
  if (!root) {
    return { ok: false, message: notACheckoutMessage(gate, new Error("git printed no path")) };
  }
  return { ok: true, root };
}

/**
 * Move the process to the repository root, or exit 1 with an explanation.
 *
 * Every dependency is injectable so the exit path itself is testable — a gate whose
 * failure branch has never been executed is exactly the shape that fails open.
 *
 * @param {string} gate
 * @param {object} [options]
 * @param {() => string} [options.toplevel]
 * @param {(dir: string) => void} [options.chdir]
 * @param {(message: string) => never} [options.fail]
 * @returns {string} the repository root
 */
export function chdirToRepoRoot(
  gate,
  {
    toplevel = gitToplevel,
    chdir = (dir) => process.chdir(dir),
    fail = (message) => {
      console.error(message);
      process.exit(1);
    },
  } = {},
) {
  const result = resolveRepoRoot({ gate, toplevel });
  if (!result.ok) return /** @type {string} */ (/** @type {unknown} */ (fail(result.message)));
  chdir(result.root);
  return result.root;
}
