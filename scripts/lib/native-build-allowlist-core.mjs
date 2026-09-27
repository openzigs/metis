/**
 * Which locked copies of a native package may run install scripts (#2).
 *
 * ## The failure this exists to catch
 *
 * `pnpm install` on `windows-latest` died before a single test ran:
 * `better-sqlite3@13` has a `binding.gyp`, pnpm runs the implicit
 * `node-gyp rebuild` for any such package it is allowed to build (it ignores the
 * package's `"gypfile": false`), and node-gyp found no Visual Studio it
 * recognised. That rebuild never mattered — 13.x BUNDLES its prebuilt binaries
 * and loads them first — so the fix is to not allow it. But the lockfile ALSO
 * carries `better-sqlite3@12` (through `@prisma/adapter-better-sqlite3`), which
 * has no bundled binary and fetches one in its install script
 * (`prebuild-install || node-gyp rebuild`). Allow too little and 12.x silently
 * ships without a binary; allow too much and Windows cannot install.
 *
 * The rule, read from the lockfile rather than hard-coded by major version: a
 * locked copy whose snapshot depends on `prebuild-install` NEEDS its install
 * script and must be allowlisted at its exact version; a copy that does not
 * must not be allowlisted at all — and neither may the bare package name, which
 * allows every version.
 *
 * Pure: the caller passes the lockfile and workspace-file text.
 */

/**
 * The `onlyBuiltDependencies` entries from pnpm-workspace.yaml, unquoted.
 *
 * @param {string} workspaceYaml
 * @returns {string[]}
 */
export function readOnlyBuiltDependencies(workspaceYaml) {
  const lines = workspaceYaml.split(/\r?\n/);
  const at = lines.findIndex((l) => /^onlyBuiltDependencies:\s*$/.test(l));
  if (at < 0) return [];
  /** @type {string[]} */
  const out = [];
  for (const line of lines.slice(at + 1)) {
    const m = line.match(/^\s+-\s+["']?([^"'#]+?)["']?\s*(#.*)?$/);
    if (!m) break;
    out.push(m[1].trim());
  }
  return out;
}

/**
 * Every locked version of `pkg`, and whether its lockfile snapshot depends on
 * `prebuild-install` (i.e. it fetches its binary in an install script).
 *
 * Reads the `snapshots:` section, where each `  <pkg>@<version>:` key lists its
 * `dependencies:` one level deeper.
 *
 * @param {string} lockfile
 * @param {string} pkg
 * @returns {Array<{ version: string, fetchesBinary: boolean }>}
 */
export function lockedVersions(lockfile, pkg) {
  const lines = lockfile.split(/\r?\n/);
  const at = lines.findIndex((l) => /^snapshots:\s*$/.test(l));
  if (at < 0) return [];
  /** @type {Array<{ version: string, fetchesBinary: boolean }>} */
  const out = [];
  /** @type {{ version: string, fetchesBinary: boolean } | null} */
  let current = null;
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    if (/^ {2}\S/.test(line)) {
      const version = snapshotVersion(line, pkg);
      current = version ? { version, fetchesBinary: false } : null;
      if (current) out.push(current);
      continue;
    }
    if (current && /^ {6}prebuild-install:/.test(line)) current.fetchesBinary = true;
  }
  return out;
}

/**
 * The version in a `snapshots:` key line (`  <pkg>@<version>:`, optionally
 * quoted) when it names `pkg` with no peer suffix, else null. String operations
 * rather than a RegExp built from `pkg`.
 *
 * @param {string} line
 * @param {string} pkg
 * @returns {string | null}
 */
function snapshotVersion(line, pkg) {
  let key = line.trim();
  if (!key.endsWith(":")) return null;
  key = key.slice(0, -1);
  if (key.length > 1 && key[0] === "'" && key.endsWith("'")) key = key.slice(1, -1);
  if (!key.startsWith(`${pkg}@`)) return null;
  const version = key.slice(pkg.length + 1);
  return version && !/[('":\s]/.test(version) ? version : null;
}

/**
 * Problems with the allowlist for `pkg`; empty when it is right.
 *
 * @param {string[]} allowlist
 * @param {Array<{ version: string, fetchesBinary: boolean }>} versions
 * @param {string} pkg
 * @returns {string[]}
 */
export function auditNativeAllowlist(allowlist, versions, pkg) {
  /** @type {string[]} */
  const problems = [];
  if (versions.length === 0) {
    problems.push(`${pkg}: no locked version found — the audit read nothing`);
    return problems;
  }
  const entries = allowlist.filter((e) => e === pkg || e.startsWith(`${pkg}@`));
  if (entries.includes(pkg)) {
    problems.push(
      `${pkg}: allowlisted by bare name, which lets EVERY version run install scripts — list exact versions`,
    );
  }
  /** @type {Set<string>} */
  const allowed = new Set();
  for (const e of entries) {
    if (e === pkg) continue;
    for (const v of e.slice(pkg.length + 1).split("||")) allowed.add(v.trim());
  }
  const locked = new Set(versions.map((v) => v.version));
  for (const v of versions) {
    if (v.fetchesBinary && !allowed.has(v.version)) {
      problems.push(
        `${pkg}@${v.version} fetches its binary in an install script (prebuild-install) but is not allowlisted — it would install with no binary`,
      );
    }
    if (!v.fetchesBinary && allowed.has(v.version)) {
      problems.push(
        `${pkg}@${v.version} bundles its binaries but is allowlisted — pnpm would run its node-gyp rebuild, which fails on Windows without Visual Studio (#2)`,
      );
    }
  }
  for (const v of allowed) {
    if (!locked.has(v)) problems.push(`${pkg}@${v} is allowlisted but not in the lockfile (stale)`);
  }
  return problems;
}
