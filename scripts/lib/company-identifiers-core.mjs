/**
 * Pure scanning core for the private-vocabulary gate.
 *
 * ## Why this exists
 *
 * METIS was developed privately before it was published, and some words — names of
 * organisations, internal systems, hosts, projects it was pointed at — must never
 * reappear in the tree. A one-off sweep fixes the tree once; it does nothing about the
 * next change that pastes a stack trace, a package path or a hostname back in. So the
 * sweep ships with this gate behind it.
 *
 * ## The vocabulary is NOT in this repository
 *
 * An earlier version of this file listed what it banned, written as `a[b]c` so the
 * source would not match its own pattern. That defeats `grep`. It does not defeat a
 * person: a published list of banned words IS the disclosure the gate exists to
 * prevent, annotated with the reason each word is sensitive. The audit that was
 * supposed to catch this searched for the literal and reported zero, because the
 * encoding was designed to make that search report zero.
 *
 * So this module contains no vocabulary at all. The runner loads the term list from
 * outside the tree (a CI secret or an untracked file — see `resolveTermSource`), and
 * the tests exercise the matcher with invented words.
 *
 * ## Never print what matched
 *
 * On a public repository the Actions log is public. A report that echoes the matched
 * text, or an excerpt of the line, publishes the term the moment the gate does its
 * job. Hits are therefore reported as `file:line` plus the term's ordinal in the list,
 * which is enough for someone who holds the list and meaningless to anyone who does not.
 *
 * ## How a term matches
 *
 * The first sweep matched one lowercase string and missed the same name written as
 * `FOO_BAR`, `FooBar` and `foo-bar`, and missed short names wherever an underscore
 * stopped `\b` from firing. Both failures are closed here by normalising the LINE
 * rather than multiplying patterns:
 *
 * - **collapsed** (default for terms of 5+ alphanumerics): line and term are reduced
 *   to lowercase alphanumerics and compared by substring. `Foo_Bar`, `foo-bar`,
 *   `FOOBAR` and `com.foobar.x` all collapse to something containing `foobar`.
 * - **token** (terms under 5 characters, or any term prefixed `=`): the line is split
 *   into lowercase tokens at non-alphanumerics AND camelCase joins, and the term's
 *   words must equal a consecutive run of tokens. A short term must not fire inside a
 *   longer word, which substring matching would do constantly.
 *
 * No `RegExp` is constructed from a term: a pattern that arrives as data is a ReDoS
 * surface (Semgrep `detect-non-literal-regexp`), and plain string comparison needs none.
 *
 * ## Fail closed
 *
 * A file this scanner cannot read is UNKNOWN, not clean (#1215), so `scanFiles`
 * collects unreadable paths separately and `isClean` treats them as failure. The same
 * applies to the list itself: an EMPTY term list is "nothing was checked", not "nothing
 * was found", so `isClean` is false for it and the runner decides — explicitly, from
 * `METIS_REQUIRE_PRIVATE_TERMS` — whether an unconfigured gate may pass.
 */

/** Terms shorter than this (after collapsing) always match as whole tokens. */
export const MIN_COLLAPSED_LENGTH = 5;

/**
 * @typedef {object} Term
 * @property {number} ordinal        1-based position among the list's terms; the ONLY
 *                                   thing a report may say about which term matched
 * @property {"collapsed" | "token"} mode
 * @property {string} collapsed      lowercase alphanumerics only (collapsed mode)
 * @property {string[]} words        lowercase tokens (token mode)
 */

/** @param {string} text @returns {string} */
export function collapse(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Lowercase tokens, split at non-alphanumerics and at camelCase joins
 * (`fooBar` → foo, bar; `HTTPServer` → http, server).
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Parse a term list: one term per line, `#` starts a comment, blank lines ignored,
 * a leading `=` forces token mode.
 *
 * @param {string} raw
 * @returns {Term[]}
 */
export function parseTerms(raw) {
  /** @type {Term[]} */
  const terms = [];
  for (const rawLine of String(raw ?? "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;
    const forcedToken = line.startsWith("=");
    const body = forcedToken ? line.slice(1).trim() : line;
    const collapsed = collapse(body);
    // A term with no alphanumerics would collapse to "" and match every line.
    if (collapsed.length === 0) continue;
    terms.push({
      ordinal: terms.length + 1,
      mode: forcedToken || collapsed.length < MIN_COLLAPSED_LENGTH ? "token" : "collapsed",
      collapsed,
      words: tokenize(body),
    });
  }
  return terms;
}

/**
 * @param {string[]} tokens
 * @param {string[]} words
 * @returns {boolean}
 */
function hasTokenRun(tokens, words) {
  if (words.length === 0) return false;
  for (let start = 0; start + words.length <= tokens.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < words.length; offset += 1) {
      if (tokens[start + offset] !== words[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Remove subresource-integrity blobs (`sha512-<base64>`) before matching.
 *
 * 88 characters of random base64 tokenise into dozens of 2-4 letter fragments, and a
 * lockfile holds thousands of them, so any short token term eventually "appears" in
 * one. This is a CONTENT rule, not a path exemption: the rest of the same line and the
 * rest of the same file are still scanned, and the blob must carry the `shaN-` prefix
 * and at least 40 base64 characters, which prose does not.
 *
 * @param {string} line
 * @returns {string}
 */
export function stripIntegrityBlobs(line) {
  return line.replace(/sha(?:1|256|384|512)-[A-Za-z0-9+/]{40,}={0,2}/g, " ");
}

/**
 * Extensions whose bytes are not prose and cannot be reviewed as text.
 * Mirrors the sibling NUL gate's list so the two agree on what "text" means.
 */
const BINARY_EXT =
  /\.(png|jpe?g|gif|ico|webp|pdf|gz|zip|woff2?|ttf|eot|node|wasm|gguf|onnx|docx|pptx|xlsx|lance|bin)$/i;

/** @param {string} filePath @returns {boolean} */
export function isTextPath(filePath) {
  return !BINARY_EXT.test(filePath);
}

/**
 * Find every private term in one file's text. A hit says WHERE and WHICH ORDINAL,
 * never what the text was — see the header.
 *
 * @param {string} text
 * @param {string} filePath repo-relative path, echoed into each hit
 * @param {Term[]} terms
 * @returns {{ file: string, line: number, ordinal: number }[]}
 */
export function scanText(text, filePath, terms) {
  /** @type {{ file: string, line: number, ordinal: number }[]} */
  const hits = [];
  if (terms.length === 0) return hits;

  text.split("\n").forEach((rawLine, index) => {
    const lineText = stripIntegrityBlobs(rawLine);
    /** @type {string | undefined} */
    let collapsedLine;
    /** @type {string[] | undefined} */
    let tokens;
    for (const term of terms) {
      let found;
      if (term.mode === "collapsed") {
        collapsedLine ??= collapse(lineText);
        found = collapsedLine.includes(term.collapsed);
      } else {
        tokens ??= tokenize(lineText);
        found = hasTokenRun(tokens, term.words);
      }
      if (found) hits.push({ file: filePath, line: index + 1, ordinal: term.ordinal });
    }
  });

  return hits;
}

/**
 * Scan a set of repo-relative paths AND the paths themselves — a directory named after
 * a private system is as much a disclosure as a line that mentions it.
 *
 * `readFile` is injected so the core stays pure. A `readFile` that throws marks the
 * path UNREADABLE, which fails the gate. It returns `null` for a path that is tracked
 * but not present in this worktree — nothing is there to contain anything, which is a
 * different answer from "could not be read".
 *
 * There is no path exclusion list, deliberately (#1382): an exempt path is a hole
 * exactly where the next paste lands.
 *
 * @param {object} options
 * @param {string[]} options.files repo-relative paths
 * @param {(filePath: string) => string | null} options.readFile
 * @param {Term[]} options.terms
 */
export function scanFiles({ files, readFile, terms }) {
  /** @type {string[]} */
  const scanned = [];
  /** @type {string[]} */
  const skippedBinary = [];
  /** @type {string[]} */
  const absent = [];
  /** @type {{ file: string, message: string }[]} */
  const unreadable = [];
  /** @type {{ file: string, line: number, ordinal: number }[]} */
  const offenders = [];

  for (const file of files) {
    // Line 0 = the path itself. Binary files are not opened, but their NAMES are text.
    for (const hit of scanText(file, file, terms)) offenders.push({ ...hit, line: 0 });

    if (!isTextPath(file)) {
      skippedBinary.push(file);
      continue;
    }

    let text;
    try {
      text = readFile(file);
    } catch (error) {
      unreadable.push({ file, message: /** @type {Error} */ (error).message });
      continue;
    }

    if (text === null) {
      absent.push(file);
      continue;
    }

    scanned.push(file);
    offenders.push(...scanText(text, file, terms));
  }

  return { scanned, skippedBinary, absent, unreadable, offenders, termCount: terms.length };
}

/**
 * The gate's verdict. Unreadable is failure, and so is an empty list: a scan against
 * zero terms found nothing because it looked for nothing.
 *
 * @param {Pick<ReturnType<typeof scanFiles>, "offenders" | "unreadable" | "termCount">} result
 * @returns {boolean}
 */
export function isClean(result) {
  return result.termCount > 0 && result.offenders.length === 0 && result.unreadable.length === 0;
}

/**
 * Where the term list comes from, in precedence order. Pure: every input is injected.
 *
 * 1. `METIS_PRIVATE_TERMS` — the list itself (CI passes a repository secret).
 * 2. `METIS_PRIVATE_TERMS_FILE` — a path to it.
 * 3. `<repo>/.private-terms` — untracked and gitignored.
 * 4. `<home>/.config/metis/private-terms.txt` — so a fresh clone or worktree on a
 *    maintainer's machine is protected before anyone remembers to copy a file into it.
 *
 * @param {object} input
 * @param {Record<string, string | undefined>} input.env
 * @param {(filePath: string) => string | null} input.readOptional returns null when absent
 * @param {string} input.repoFile
 * @param {string | null} input.homeFile
 * @returns {{ source: string, raw: string } | null}
 */
export function resolveTermSource({ env, readOptional, repoFile, homeFile }) {
  const inline = env.METIS_PRIVATE_TERMS;
  if (inline && inline.trim().length > 0) return { source: "env METIS_PRIVATE_TERMS", raw: inline };

  const candidates = [
    [env.METIS_PRIVATE_TERMS_FILE, "METIS_PRIVATE_TERMS_FILE"],
    [repoFile, ".private-terms"],
    [homeFile, "~/.config/metis/private-terms.txt"],
  ];
  for (const [candidate, label] of candidates) {
    if (!candidate) continue;
    const raw = readOptional(candidate);
    if (raw !== null && raw.trim().length > 0) return { source: `file ${label}`, raw };
  }
  return null;
}

/** @param {Record<string, string | undefined>} env @returns {boolean} */
export function termsRequired(env) {
  const value = (env.METIS_REQUIRE_PRIVATE_TERMS ?? "").trim().toLowerCase();
  return value === "1" || value === "true";
}

/**
 * Human-readable report. Never contains a term, a match or a line excerpt.
 *
 * @param {ReturnType<typeof scanFiles>} result
 * @param {string} source where the list came from, for the summary line
 * @returns {string[]}
 */
export function formatReport(result, source) {
  const lines = [];

  if (result.unreadable.length > 0) {
    lines.push("Tracked files that could not be read, so were NOT scanned:", "");
    for (const entry of result.unreadable) lines.push(`  ${entry.file}  (${entry.message})`);
    lines.push(
      "",
      "A file this gate cannot open is UNKNOWN, not clean (#1215). Fix the path or the " +
        "permissions rather than letting it read as a pass.",
      "",
    );
  }

  if (result.offenders.length > 0) {
    lines.push("Private vocabulary found in the publishable tree:", "");
    for (const hit of result.offenders) {
      const where = hit.line === 0 ? `${hit.file}  (in the PATH)` : `${hit.file}:${hit.line}`;
      lines.push(`  ${where}  term #${hit.ordinal}`);
    }
    lines.push(
      "",
      "The matched text is deliberately not shown: this log may be public. Term numbers " +
        "index the maintainers' private list. Replace the wording with a neutral " +
        "placeholder (example.com, com.acme). Do not exempt a path — an exempt path is a " +
        "hole exactly where the next paste lands.",
      "",
    );
  }

  if (result.termCount === 0) {
    lines.push("verify-no-company-identifiers: the term list is EMPTY — nothing was checked.");
  } else if (isClean(result)) {
    lines.push(
      `verify-no-company-identifiers: ${result.scanned.length} tracked text files and ` +
        `${result.scanned.length + result.skippedBinary.length + result.absent.length} paths ` +
        `scanned against ${result.termCount} private terms (${source}), none found.` +
        (result.absent.length > 0
          ? ` (${result.absent.length} tracked path(s) not present in this worktree.)`
          : ""),
    );
  }

  return lines;
}
