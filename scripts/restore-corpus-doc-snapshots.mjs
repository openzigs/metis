#!/usr/bin/env node
/**
 * Issue #1382 — rebuild the untracked doc snapshots every eval corpus needs.
 *
 * ```bash
 * pnpm eval:restore-corpus            # rebuild anything missing; no-op when complete
 * pnpm eval:restore-corpus --resync   # also overwrite a snapshot that has DRIFTED
 * ```
 *
 * `eval-data/corpus/<id>/docs/` is gitignored since #1382, so a fresh clone does not
 * have it — and `server/src/lib/eval/doc-retrieval/corpus.ts` reads it directly, as do
 * 34 tests. This script puts it back from the only place the exact bytes exist: the
 * corpus's own `snapshotCommit`, through the `source` path and sha256 that
 * `snapshot-manifest.json` commits for every file.
 *
 * It is wired into the SERVER package's `test` and `test:coverage`, because that is the
 * package whose tests read the corpus — `ci.yml`'s `postgres-adapter` job runs
 * `pnpm test` with `working-directory: server` and never sees the root script. The
 * nightly runs it too. `scripts/lib/corpus-restore-wiring.test.mjs` pins both.
 *
 * When every file is present and hashes correctly — which is the case on any machine
 * that has run it once, since the output is ignored rather than cleaned — it reads 38
 * files and exits, touching neither the network nor git.
 *
 * ## Where this stops working
 *
 * In a repository with no history. #1295 creates the public repo from a single squashed
 * commit, which has no `snapshotCommit` to read and no origin to fetch one from, so this
 * exits 1 and takes the server suite with it. That is deliberate — failing is better
 * than measuring a corpus that is not the one the manifest names — but it means the
 * publication step has to materialise each corpus's `docs/` directory into the squashed
 * commit, or re-cut the corpus. ADR 0015's Consequences section carries the detail.
 *
 * Exit codes: 0 everything present and verified, 1 anything it could not produce or
 * verify. There is deliberately no "could not restore, carrying on" path: that is how
 * a test suite ends up measuring a corpus that is not the one it names.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  formatRestoreReport,
  isSatisfied,
  planSnapshotRestore,
} from "./lib/corpus-snapshot-restore-core.mjs";
import { chdirToRepoRoot } from "./lib/repo-root.mjs";

const CORPUS_ROOT = path.join("eval-data", "corpus");
const MANIFEST_FILE = "snapshot-manifest.json";

/** @param {Buffer|string} buf */
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/**
 * sha256 of a file, or `null` when it is not there.
 *
 * Only ENOENT reads as absent. Any other error — a permission problem, a directory
 * where a file should be — is a fact we do not know, and claiming "absent" for it
 * would restore over something we failed to look at.
 *
 * @param {string} abs
 * @returns {string | null}
 */
function hashFile(abs) {
  try {
    return sha256(fs.readFileSync(abs));
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
    throw error;
  }
}

/** @returns {string[]} corpus ids that commit a snapshot manifest */
function corporaWithManifests() {
  let entries;
  try {
    entries = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => fs.existsSync(path.join(CORPUS_ROOT, id, MANIFEST_FILE)))
    .sort();
}

/**
 * Make `commit` readable, fetching it if this is a shallow clone.
 *
 * CI checks out at depth 1, so the snapshot commit is genuinely absent there rather
 * than merely unreferenced. GitHub serves a fetch by explicit sha, which is why this
 * works without `fetch-depth: 0` on every job.
 *
 * @param {string} commit
 * @returns {boolean} whether the object is now present
 */
function ensureCommit(commit) {
  const present = spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
    stdio: "ignore",
  });
  if (present.status === 0) return true;

  const fetched = spawnSync("git", ["fetch", "--depth=1", "origin", commit], {
    stdio: "inherit",
  });
  if (fetched.status !== 0) return false;

  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" }).status === 0
  );
}

function main() {
  const resyncDrifted = process.argv.includes("--resync");
  const lines = [];
  let failed = false;

  for (const corpusId of corporaWithManifests()) {
    const dir = path.join(CORPUS_ROOT, corpusId);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
    const plan = planSnapshotRestore({
      manifest,
      hashOf: (rel) => hashFile(path.join(dir, rel)),
      resyncDrifted,
    });

    // A corpus with no `docs/` entries in its manifest has nothing here to restore.
    if (plan.upToDate.length === 0 && isSatisfied(plan)) continue;

    /** @type {string[]} */
    const written = [];

    if (plan.restore.length > 0) {
      if (!ensureCommit(manifest.snapshotCommit)) {
        lines.push(
          `${corpusId}: cannot restore — commit ${manifest.snapshotCommit} is not in this ` +
            `clone and could not be fetched from origin. Fetch it (git fetch --depth=1 ` +
            `origin ${manifest.snapshotCommit}) or run with full history. If this is a ` +
            `repository created from a SQUASHED commit (#1295), that commit does not ` +
            `exist here at all: the snapshot has to be committed alongside the corpus, ` +
            `or the corpus re-cut against a commit this history contains — see ADR 0015.`,
        );
        failed = true;
        continue;
      }

      for (const entry of plan.restore) {
        const blob = execFileSync("git", ["show", `${manifest.snapshotCommit}:${entry.source}`], {
          maxBuffer: 64 * 1024 * 1024,
        });

        // An entry carrying `sourceSha256` was edited before this repository was
        // published, so its committed bytes deliberately match no blob at any commit.
        // The committed snapshot IS the source of truth for it; there is nothing to
        // re-derive it from, and restoring the raw blob would undo the edit. Refuse
        // rather than write bytes the manifest does not describe.
        if (entry.sourceSha256) {
          lines.push(
            `${corpusId}: REFUSED ${entry.rel} — this snapshot was edited before ` +
              `publication and cannot be restored from history. Recover the committed ` +
              `file instead (git checkout -- ${path.posix.join("eval-data/corpus", corpusId, entry.rel)}).`,
          );
          failed = true;
          continue;
        }
        const payload = blob;

        const actual = sha256(payload);
        if (actual !== entry.sha256) {
          // The manifest is the contract. If git hands back different bytes, writing
          // them would launder a corpus that is not the one the manifest describes.
          lines.push(
            `${corpusId}: REFUSED ${entry.rel} — ${manifest.snapshotCommit}:${entry.source} ` +
              `hashes ${actual.slice(0, 12)}, the manifest records ${entry.sha256.slice(0, 12)}.`,
          );
          failed = true;
          continue;
        }
        const abs = path.join(dir, entry.rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, payload);
        written.push(entry.rel);
      }
    }

    lines.push(
      ...formatRestoreReport({ corpusId, snapshotCommit: manifest.snapshotCommit, plan, written }),
    );
    if (plan.unrestorable.length > 0) failed = true;
    if (plan.drifted.length > 0 && !resyncDrifted) failed = true;
  }

  const report =
    lines.join("\n") || "restore-corpus-doc-snapshots: no corpus commits a snapshot manifest.";
  if (failed) {
    console.error(report);
    process.exit(1);
  }
  console.log(report);
}

chdirToRepoRoot("restore-corpus-doc-snapshots");
main();
