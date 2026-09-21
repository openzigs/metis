/**
 * Epic #298 / Issue #308 — `.metisignore` filter (gitignore syntax).
 *
 * Minimal reimplementation of the gitignore matcher subset needed for ingest:
 *   - `# comment` lines and blank lines are skipped
 *   - Trailing `/` marks a directory-only pattern
 *   - Leading `/` anchors at the repo root
 *   - `*` matches anything except `/`
 *   - `**` matches anything including `/`
 *   - `?` matches a single non-`/` character
 *   - Leading `!` negates (re-includes) a previously excluded path
 *
 * Patterns we deliberately do NOT support (out of scope for v1):
 *   - Character classes `[abc]`
 *   - Backslash escapes
 *
 * If you need full fidelity, swap this out for the `ignore` npm package
 * (the only reason we are not pulling it now is to keep the dep surface small
 * for the wrapper-image-bound code path which has its own slimmer dep set).
 */

interface CompiledRule {
  /** RegExp matching paths against this pattern. */
  re: RegExp;
  /** True for lines starting with `!` — negates a prior match. */
  negate: boolean;
  /** True when the pattern ends with `/` (directories only). */
  dirOnly: boolean;
}

function patternToRegex(raw: string): { re: RegExp; dirOnly: boolean } {
  let pattern = raw;
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);

  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);

  // Build the regex piece by piece so `**` is not eaten by the `*` rule.
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i += 2;
        // Eat a following slash to avoid `**/foo` becoming `.*\/foo` requiring a slash.
        if (pattern[i] === "/") i += 1;
      } else {
        body += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      body += "[^/]";
      i += 1;
    } else if (c === ".") {
      body += "\\.";
      i += 1;
    } else if (c === "/") {
      body += "/";
      i += 1;
    } else if (/[a-zA-Z0-9_\-+@~]/.test(c)) {
      body += c;
      i += 1;
    } else {
      // Defensive: escape anything else literally.
      body += `\\${c}`;
      i += 1;
    }
  }

  // If the pattern contains no slash and was not anchored, match against any
  // segment of the path (gitignore default behaviour).
  const containsSlash = pattern.includes("/");
  let prefix = "^";
  if (!anchored && !containsSlash) prefix = "(^|/)";
  else if (!anchored && containsSlash) prefix = "(^|/)";

  // Trailing match: must hit end of segment unless the pattern ended in `**`.
  const suffix = pattern.endsWith("**") ? "" : "(/|$)";

  return {
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `body` is assembled char-by-char with every non-glob character escaped; input is a repo-local .metisignore file (trusted config), and the pattern is anchored with bounded classes.
    re: new RegExp(prefix + body + suffix),
    dirOnly,
  };
}

export function compileMetisignore(content: string): CompiledRule[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((raw) => {
      const negate = raw.startsWith("!");
      const body = negate ? raw.slice(1) : raw;
      const { re, dirOnly } = patternToRegex(body);
      return { re, negate, dirOnly };
    });
}

/**
 * Returns true when `relPath` is excluded by the rule list.
 * `relPath` is forward-slash-delimited and relative to the repo root.
 * `isDir` indicates whether the path refers to a directory.
 *
 * Gitignore semantics: when a directory matches a `dir/` style rule, every
 * descendant of that directory is also ignored. We honour this by walking
 * each path ancestor and checking dir-only rules against it as a directory.
 */
export function isIgnored(rules: CompiledRule[], relPath: string, isDir = false): boolean {
  // Build the list of ancestor directories. For "a/b/c.ts" → ["a", "a/b"].
  // For directories the path itself counts as the leaf.
  const segments = relPath.split("/");
  const ancestors: string[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    ancestors.push(segments.slice(0, i).join("/"));
  }

  let ignored = false;
  for (const rule of rules) {
    if (rule.dirOnly) {
      // Match against every ancestor (always treated as directories) AND the
      // leaf when the leaf itself is a directory.
      let dirHit = false;
      for (const ancestor of ancestors) {
        if (rule.re.test(ancestor)) {
          dirHit = true;
          break;
        }
      }
      if (!dirHit && isDir && rule.re.test(relPath)) dirHit = true;
      if (dirHit) ignored = !rule.negate;
    } else if (rule.re.test(relPath)) {
      ignored = !rule.negate;
    }
  }
  return ignored;
}

export const DEFAULT_METISIGNORE = `# Default exclusions for the code-graph ingest pipeline (Epic #298).
# Override in your repo by adding a top-level .metisignore.
node_modules/
.git/
.next/
dist/
build/
out/
coverage/
.venv/
__pycache__/
vendor/
*.min.js
*.generated.ts
*.generated.js
`;
