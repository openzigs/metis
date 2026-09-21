/**
 * Cross-platform `clean` helper (Issue #187 / Epic #183).
 *
 * Replaces the POSIX-only root `clean` script
 *   `rm -rf node_modules **\/node_modules **\/dist **\/.next **\/coverage`
 * with a Node implementation that runs identically on Windows, macOS, and
 * Linux — no bash, no `rm`, no external `rimraf` dependency (Node ≥ 14 ships
 * `fs.rm({ recursive: true, force: true })`).
 *
 * The module is split into a PURE planner (`cleanTargets`, `isProtectedPath`,
 * `expandTargets`) and an IMPACTFUL executor (`removeMatches`, `runClean`) so
 * the path logic is unit-testable without touching the filesystem.
 */
import { rm, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

/**
 * The exact removal set, preserving the original glob semantics:
 *   node_modules, **\/node_modules, **\/dist, **\/.next, **\/coverage
 *
 * `node_modules` (root) is covered by the recursive `node_modules` match, but
 * we keep the names explicit for parity with the documented set.
 *
 * @type {readonly string[]}
 */
export const cleanTargets = Object.freeze(["node_modules", "dist", ".next", "coverage"]);

/**
 * Directory names we must never recurse INTO while searching for targets.
 * Without this guard, walking a freshly-installed tree would descend into
 * every package's `node_modules` (hundreds of thousands of entries) — slow and
 * pointless, since we already delete `node_modules` wholesale at each level.
 *
 * @type {ReadonlySet<string>}
 */
const PRUNE_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);

/**
 * True when `name` is one of the directories we remove.
 *
 * @param {string} name - a single path segment (not a full path).
 * @returns {boolean}
 */
export function isCleanTarget(name) {
  return cleanTargets.includes(name);
}

/**
 * Reject absolute paths or paths that escape the root via `..`. Defense in
 * depth: callers only ever pass repo-relative discovered paths, but we never
 * want a crafted directory name to cause a delete outside the repo root.
 *
 * @param {string} root - absolute repo root.
 * @param {string} candidate - absolute path to validate.
 * @returns {boolean} true when `candidate` is safely contained within `root`.
 */
export function isWithinRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved === resolvedRoot) return false; // never delete the root itself
  const rel = path.relative(resolvedRoot, resolved);
  return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Walk `root` and collect absolute paths of every directory whose basename is
 * in {@link cleanTargets}. Pure aside from `readdir`; the directory listing is
 * injectable for tests.
 *
 * @param {string} root - absolute repo root to scan.
 * @param {object} [deps]
 * @param {(dir: string) => Promise<Array<{ name: string, isDirectory: () => boolean }>>} [deps.list]
 *   directory reader returning Dirent-like entries (defaults to `fs.readdir`).
 * @returns {Promise<string[]>} matched absolute directory paths.
 */
export async function findCleanMatches(root, deps = {}) {
  const list =
    /* c8 ignore next — real fs.readdir; tests inject list */
    deps.list ?? ((dir) => readdir(dir, { withFileTypes: true }));
  /** @type {string[]} */
  const matches = [];

  /** @param {string} dir */
  async function walk(dir) {
    /** @type {Array<{ name: string, isDirectory: () => boolean }>} */
    let entries;
    try {
      entries = await list(dir);
    } catch {
      return; // unreadable / vanished directory — skip silently
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (isCleanTarget(entry.name)) {
        if (isWithinRoot(root, full)) matches.push(full);
        // Do not recurse into a matched target — it is about to be removed.
        continue;
      }
      if (PRUNE_DIRS.has(entry.name)) continue;
      await walk(full);
    }
  }

  await walk(path.resolve(root));
  return matches;
}

/**
 * Remove every path in `targets`, idempotently (missing paths are ignored,
 * matching `rm -rf` semantics).
 *
 * @param {string[]} targets - absolute paths to remove.
 * @param {object} [deps]
 * @param {(p: string) => Promise<void>} [deps.remove] - remover (defaults to `fs.rm` recursive+force).
 * @param {(msg: string) => void} [deps.log] - logger (defaults to `console.log`).
 * @returns {Promise<number>} count of paths removed.
 */
export async function removeMatches(targets, deps = {}) {
  const remove =
    /* c8 ignore next — real fs.rm; tests inject remove */
    deps.remove ?? ((p) => rm(p, { recursive: true, force: true }));
  /* c8 ignore next — default console logger */
  const log = deps.log ?? ((m) => console.log(m));
  let removed = 0;
  for (const target of targets) {
    await remove(target);
    removed += 1;
    log(`removed ${target}`);
  }
  return removed;
}

/**
 * Full clean: discover matches under `root` and remove them.
 *
 * @param {string} root - absolute repo root.
 * @param {object} [deps] - injected dependencies for {@link findCleanMatches} and {@link removeMatches}.
 * @returns {Promise<number>} count of removed paths.
 */
export async function runClean(root, deps = {}) {
  const matches = await findCleanMatches(root, deps);
  return removeMatches(matches, deps);
}

/* c8 ignore start — CLI entrypoint, exercised via `pnpm clean`, not unit tests */
// CLI entrypoint: `node scripts/lib/clean.mjs`
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("clean.mjs")) {
  const root = process.cwd();
  runClean(root)
    .then((n) => {
      console.log(`clean: removed ${n} director${n === 1 ? "y" : "ies"}.`);
    })
    .catch((err) => {
      console.error(`clean failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
/* c8 ignore stop */
