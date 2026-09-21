/**
 * Issue #1382 — decision core for rebuilding a corpus's frozen doc snapshot.
 *
 * ## Why this exists
 *
 * `eval-data/corpus/<id>/docs/` holds 38 markdown files that are byte-identical
 * copies of this repository's own `docs/*.md` at the corpus's `snapshotCommit`.
 * #1382 untracked them: they are a second copy of content git already stores, and
 * the copy was frozen before #1373's company-identifier sweep, so it still carried
 * the identifier the published tree may not contain.
 *
 * Untracking something that a test suite reads is only safe if it can be put back
 * exactly. It can: every entry in the committed `snapshot-manifest.json` records
 * both the `source` path and the sha256 the file had at `snapshotCommit`, so
 * `git show <snapshotCommit>:<source>` reproduces the bytes and the recorded hash
 * proves it reproduced them. This module decides WHAT to rebuild; the runner
 * (`scripts/restore-corpus-doc-snapshots.mjs`) owns git and the filesystem.
 *
 * ## The rule this core encodes
 *
 * **Absent and drifted are different, and neither is silently OK.** A file that is
 * simply not there is the fresh-clone case and is restored. A file that is there
 * but hashes differently has DRIFTED — someone edited a frozen snapshot — and
 * overwriting it would erase the evidence, so it is reported and left alone unless
 * the caller explicitly asks for a resync. And an entry with no `source` cannot be
 * rebuilt from history at all; if it is missing, that is a hard failure rather than
 * something to shrug at, because the corpus is then incomplete and every downstream
 * measurement is taken over a different corpus than the one it names.
 */

/** The snapshot subdirectory this restore covers, with its trailing slash. */
export const DOC_SNAPSHOT_PREFIX = "docs/";

/**
 * Decide what has to be rebuilt for one corpus.
 *
 * @param {object} input
 * @param {{ files: Record<string, { sha256: string, source: string | null, sourceSha256?: string }> }} input.manifest
 * @param {(rel: string) => string | null} input.hashOf
 *   sha256 of the file on disk, or `null` when it is not there at all.
 * @param {string} [input.prefix] manifest keys to consider; defaults to `docs/`.
 * @param {boolean} [input.resyncDrifted] rebuild a drifted file instead of reporting it.
 * @returns {{
 *   restore: { rel: string, source: string, sha256: string }[],
 *   upToDate: string[],
 *   drifted: { rel: string, expected: string, actual: string }[],
 *   unrestorable: { rel: string, reason: string }[],
 * }}
 */
export function planSnapshotRestore({
  manifest,
  hashOf,
  prefix = DOC_SNAPSHOT_PREFIX,
  resyncDrifted = false,
}) {
  /** @type {{ rel: string, source: string, sha256: string, sourceSha256?: string }[]} */
  const restore = [];
  /** @type {string[]} */
  const upToDate = [];
  /** @type {{ rel: string, expected: string, actual: string }[]} */
  const drifted = [];
  /** @type {{ rel: string, reason: string }[]} */
  const unrestorable = [];

  for (const [rel, entry] of Object.entries(manifest.files ?? {})) {
    if (!rel.startsWith(prefix)) continue;

    const actual = hashOf(rel);

    if (actual === entry.sha256) {
      upToDate.push(rel);
      continue;
    }

    if (entry.source === null) {
      // No provenance claim, so there is nothing in history to rebuild it from.
      // Present-but-drifted is still reportable; absent is unrecoverable.
      if (actual === null) {
        unrestorable.push({
          rel,
          reason:
            "the manifest records no `source` for it, so it cannot be rebuilt from " +
            "history — restore it from a backup or re-cut the corpus",
        });
      } else {
        drifted.push({ rel, expected: entry.sha256, actual });
      }
      continue;
    }

    if (actual !== null && !resyncDrifted) {
      drifted.push({ rel, expected: entry.sha256, actual });
      continue;
    }

    // `sourceSha256` must survive into the plan: it marks an entry that was edited
    // before publication, which the caller refuses to restore from history. Dropping it
    // here silently sent those entries down the ordinary path, where the raw blob then
    // failed a hash check it was never meant to satisfy.
    restore.push({
      rel,
      source: entry.source,
      sha256: entry.sha256,
      ...(entry.sourceSha256 ? { sourceSha256: entry.sourceSha256 } : {}),
    });
  }

  return { restore, upToDate, drifted, unrestorable };
}

/**
 * Is there nothing at all to do for this corpus?
 *
 * @param {ReturnType<typeof planSnapshotRestore>} plan
 * @returns {boolean}
 */
export function isSatisfied(plan) {
  return plan.restore.length === 0 && plan.drifted.length === 0 && plan.unrestorable.length === 0;
}

/**
 * Render one corpus's plan, or its outcome once the runner has acted on it.
 *
 * Kept here so the wording is testable without spawning git.
 *
 * @param {object} input
 * @param {string} input.corpusId
 * @param {string} input.snapshotCommit
 * @param {ReturnType<typeof planSnapshotRestore>} input.plan
 * @param {string[]} [input.written] paths the runner actually wrote
 * @returns {string[]}
 */
export function formatRestoreReport({ corpusId, snapshotCommit, plan, written = [] }) {
  const lines = [];
  const short = snapshotCommit.slice(0, 8);

  if (written.length > 0) {
    lines.push(`${corpusId}: restored ${written.length} snapshot file(s) from ${short}`);
  } else if (plan.restore.length > 0) {
    lines.push(`${corpusId}: ${plan.restore.length} snapshot file(s) to restore from ${short}`);
  } else {
    lines.push(`${corpusId}: ${plan.upToDate.length} snapshot file(s) already match ${short}`);
  }

  for (const entry of plan.drifted) {
    lines.push(
      `  DRIFTED  ${entry.rel} — on disk it hashes ${entry.actual.slice(0, 12)}, the ` +
        `manifest for ${short} records ${entry.expected.slice(0, 12)}. A frozen snapshot ` +
        `was edited. Nothing was overwritten, so the edit is still there to look at; ` +
        `re-run with --resync to take the committed bytes instead.`,
    );
  }
  for (const entry of plan.unrestorable) {
    lines.push(`  MISSING  ${entry.rel} — ${entry.reason}`);
  }

  return lines;
}
