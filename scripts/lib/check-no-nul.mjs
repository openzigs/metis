#!/usr/bin/env node
/**
 * Reject literal NUL (0x00) bytes in tracked TEXT files.
 *
 * ## Why this exists
 *
 * PR #803 shipped a raw NUL byte TWICE. A NUL in a text file is not cosmetic — git's
 * binary heuristic sniffs only the FIRST 8000 bytes of a blob, and it classifies any
 * blob containing a NUL in that window as BINARY. A binary file is:
 *
 *   - not diffable (`gh pr diff` emits nothing; GitHub renders "Binary file not shown"),
 *   - not reviewable (inline review comments are rejected on it), and
 *   - SILENTLY SKIPPED by Semgrep — the security check still reports green.
 *
 * The first occurrence turned a 615-line source file into an unreviewable, unscanned
 * blob. The second sat at byte ~43k of CHANGELOG.md — PAST the 8000-byte sniff window,
 * so git called it text and every gate stayed green while the byte rode along. Detection
 * by eye clearly does not work, so it is automated here.
 *
 * The fix is never to delete the character but to write it as an ESCAPE: `"\u0000"` is
 * the same string at runtime and plain ASCII on disk.
 *
 * Scope: the WHOLE repository's tracked files — the enumeration is anchored to the repo
 * root before it runs, because `git ls-files` is relative to the current directory and
 * this gate reported success over half a tree when invoked from `server/` (#1381; the
 * policy and the no-repository decision live in `repo-root.mjs`). Of those, only the
 * files git itself does not consider binary by attribute are read (`*.png binary`, real
 * fixtures like `sample.docx`, etc. are legitimately binary and are skipped via
 * `git check-attr`).
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";

import { chdirToRepoRoot } from "./repo-root.mjs";

/** Extensions that are legitimately binary content, independent of .gitattributes. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|pdf|gz|zip|woff2?|ttf|eot|node|wasm|gguf|onnx|docx|pptx|xlsx|lance|bin)$/i;

/**
 * Every tracked path in the REPOSITORY.
 *
 * Correct only because `chdirToRepoRoot` has already run below: `git ls-files` answers
 * about the current directory's subtree, so this function is cwd-sensitive by
 * construction and the anchoring is what makes its name true (#1381).
 *
 * @returns {string[]}
 */
function tracked() {
  const out = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  return out
    .toString("utf8")
    .split("\0")
    .filter((f) => f.length > 0);
}

/**
 * Files git has been TOLD are binary (.gitattributes) — not our business.
 *
 * @param {string[]} files
 * @returns {Set<string>}
 */
function attrBinary(files) {
  if (files.length === 0) return new Set();
  const out = execFileSync("git", ["check-attr", "--stdin", "-z", "binary"], {
    input: Buffer.from(files.join("\0"), "utf8"),
    maxBuffer: 64 * 1024 * 1024,
  }).toString("utf8");
  // NUL-separated triples: path, attr, value
  const parts = out.split("\0");
  const flagged = new Set();
  for (let i = 0; i + 2 < parts.length; i += 3) {
    if (parts[i + 2] === "set") flagged.add(parts[i]);
  }
  return flagged;
}

// Anchor BEFORE enumerating. Everything below is relative paths read through the
// process cwd, so this line is what makes them repo-relative rather than caller-relative.
chdirToRepoRoot("check-no-nul");

const files = tracked().filter((f) => !BINARY_EXT.test(f));
const skip = attrBinary(files);
const offenders = [];
/** Tracked but absent from this worktree — legitimately nothing to scan. */
const absent = [];
/** Tracked, present, and NOT scanned. That is unknown, not clean (#1215). */
const unreadable = [];

// `catch { continue }` around the read was a fail-open, and the summary line made it
// worse by counting the file as scanned anyway. Measured: a tracked file containing a
// NUL, chmod 000 (EACCES) or replaced by a directory (EISDIR), takes this gate from
// exit 1 to exit 0 while printing "3 tracked text files, no NUL bytes" — a claim about
// a file it never opened (#1215).
//
// The fix has to classify by WHAT GIT STORES, not by what a blind read happens to
// throw. Reading through the worktree entry conflates three different things, and the
// first naive fix failed this repository's own tree: `.claude/skills/*` are 14 tracked
// SYMLINKS to directories, so `readFileSync` follows them and throws EISDIR on every
// one. They are not unreadable — their blob is the link TEXT, and the pointed-at files
// are separately tracked and scanned under `.github/skills/`.
//
// So `lstat` decides, because that is the question git is answering:
//   symlink   -> the blob is the target path string; scan that, not the target's bytes
//   file      -> read it; a failure now is genuinely unreadable and fails the gate
//   ENOENT    -> tracked but not checked out. Nothing is there to contain anything.
//   anything else (a directory where the index says blob, an unstat-able path)
//             -> UNKNOWN, and unknown is not clean.
for (const file of files) {
  if (skip.has(file)) continue;
  let entry;
  try {
    entry = lstatSync(file);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") {
      absent.push(file);
      continue;
    }
    unreadable.push({ file, message: /** @type {Error} */ (error).message });
    continue;
  }

  let buf;
  if (entry.isSymbolicLink()) {
    try {
      buf = Buffer.from(readlinkSync(file), "utf8");
    } catch (error) {
      unreadable.push({ file, message: /** @type {Error} */ (error).message });
      continue;
    }
  } else if (entry.isFile()) {
    try {
      buf = readFileSync(file);
    } catch (error) {
      unreadable.push({ file, message: /** @type {Error} */ (error).message });
      continue;
    }
  } else {
    unreadable.push({
      file,
      message: `the index records a blob, but the worktree holds a ${
        entry.isDirectory() ? "directory" : "non-regular file"
      }`,
    });
    continue;
  }

  const idx = buf.indexOf(0);
  if (idx !== -1) {
    // Report the LINE, so the fix is obvious.
    const line = buf.subarray(0, idx).toString("utf8").split("\n").length;
    offenders.push({ file, line, offset: idx });
  }
}

if (unreadable.length > 0) {
  console.error("Tracked text files that could not be read, so were NOT scanned:\n");
  for (const u of unreadable) console.error(`  ${u.file}  (${u.message})`);
  console.error(
    "\nA file this check cannot open is UNKNOWN, not clean — the whole point of the gate " +
      "is that a NUL is invisible to the eye, so skipping the file silently is the one " +
      "outcome that must not read as a pass (#1215). Fix the permissions or the path.\n",
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error("Literal NUL (0x00) byte found in tracked text files:\n");
  for (const o of offenders) {
    console.error(`  ${o.file}:${o.line}  (byte offset ${o.offset})`);
  }
  console.error(
    "\nA NUL makes git treat the file as BINARY: undiffable, unreviewable, and " +
      "silently skipped by Semgrep while the check still passes.\n" +
      'Write the escape instead — "\\u0000" is the identical string at runtime and ' +
      "ASCII on disk.\n",
  );
  process.exit(1);
}

// The count is of files actually OPENED. It used to be `files.length - skip.size`,
// which counted every candidate whether or not it was read — so a skipped file was
// reported as a scanned one.
const scanned = files.length - skip.size - absent.length;
console.log(
  `check-no-nul: ${scanned} tracked text files scanned, no NUL bytes.` +
    (absent.length > 0 ? ` (${absent.length} tracked path(s) not present in this worktree.)` : ""),
);
