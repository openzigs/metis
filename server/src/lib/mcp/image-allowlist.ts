/**
 * Issue #275 — Image allowlist matcher for containerised MCP runtimes.
 *
 * Patterns are segment-aware globs evaluated over the registry path
 * (e.g. `ghcr.io/metis-mcps/*`). Tag fragments (`:tag` or `@sha256:...`)
 * are stripped before matching so a pattern matches both `repo` and
 * `repo:tag` forms.
 *
 * Glob semantics (Issue #304 — tightened from loose to segment-aware):
 *   - `*`  matches any sequence of characters EXCEPT `/` (i.e. one path segment)
 *   - `**` matches any sequence of characters INCLUDING `/` (multiple segments)
 *
 *   `ghcr.io/metis-mcps/*`  matches `ghcr.io/metis-mcps/foo:tag`
 *                            but NOT `ghcr.io/metis-mcps/foo/bar:tag`
 *   `ghcr.io/metis-mcps/**` matches both.
 *
 * Used by:
 *   - `MCPRegistryService.create()` / `update()` validation
 *   - Containerisation Phase A (#271) docker-stdio provisioner pre-flight
 *   - Containerisation Phase B (#272) k8s-sse provisioner pre-flight
 */

/** Strip `:tag` or `@sha256:...` from an image reference. */
export function stripImageTag(image: string): string {
  // Handle digest first (`repo@sha256:...`).
  const atIdx = image.indexOf("@");
  if (atIdx !== -1) return image.slice(0, atIdx);
  // For tag suffix, only strip after the last `/` to avoid mauling
  // registries that include a port (`localhost:5000/foo`).
  const lastSlash = image.lastIndexOf("/");
  const tail = lastSlash === -1 ? image : image.slice(lastSlash + 1);
  const colonIdx = tail.indexOf(":");
  if (colonIdx === -1) return image;
  return (lastSlash === -1 ? "" : image.slice(0, lastSlash + 1)) + tail.slice(0, colonIdx);
}

/** Compile a CSV pattern list into trimmed, non-empty entries. */
export function parseAllowlistCsv(csv: string | null | undefined): string[] {
  if (!csv) return [];
  return csv
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Match a single segment-aware glob pattern against a literal string.
 *
 * `*`  → `[^/]*` (matches one path segment — does NOT span `/`)
 * `**` → `.*`    (matches zero or more characters including `/`)
 *
 * All other regex metacharacters are escaped. Pattern is fully anchored.
 */
export function matchGlob(pattern: string, value: string): boolean {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      // Detect `**` first — must be checked before single `*` so we don't
      // emit two consecutive `[^/]*` runs.
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 2;
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`;
    } else {
      re += ch;
    }
    i += 1;
  }
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp -- `re` is built by escaping every regex metacharacter and only expanding `*`/`**` into bounded classes; the regex is fully anchored, so no injection or ReDoS is possible.
  return new RegExp(`^${re}$`).test(value);
}

/**
 * Returns `true` when `image` matches at least one pattern in `patterns`.
 * Patterns are matched against the tag-stripped image path.
 *
 * Empty pattern list => fail closed (always rejects).
 */
export function imageMatchesAllowlist(image: string, patterns: readonly string[]): boolean {
  if (patterns.length === 0) return false;
  const stripped = stripImageTag(image);
  return patterns.some((p) => matchGlob(p, image) || matchGlob(p, stripped));
}

/**
 * Heuristic: extract the image reference from a `docker run …` argv. Returns
 * `null` if no image-shaped token is found.
 *
 * Algorithm: scan `args` left-to-right, skip flag tokens (`-x`, `--foo`) and
 * their values when the flag accepts one (we treat ANY flag as taking a
 * value unless it is a known boolean flag), and return the first remaining
 * positional token. Stops at `--` or `-c`.
 */
export function extractDockerImage(args: readonly string[] | null | undefined): string | null {
  if (!args || args.length === 0) return null;
  // The first positional after `run` (or at start if no `run`).
  let idx = 0;
  if (args[0] === "run") idx = 1;
  // Boolean flags that don't take a value — restrict the value-eating
  // heuristic so we don't accidentally swallow the image.
  const BOOL_FLAGS = new Set([
    "-d",
    "--detach",
    "-i",
    "--interactive",
    "-t",
    "--tty",
    "--rm",
    "--init",
    "--privileged",
    "-q",
    "--quiet",
    "--read-only",
  ]);
  while (idx < args.length) {
    const tok = args[idx];
    if (tok === "--" || tok === "-c") return null;
    if (tok.startsWith("--") && tok.includes("=")) {
      idx += 1;
      continue;
    }
    if (tok.startsWith("-")) {
      idx += BOOL_FLAGS.has(tok) ? 1 : 2;
      continue;
    }
    return tok;
  }
  return null;
}
