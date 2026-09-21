/**
 * Epic #165 (#113) — `skillDirectories` filesystem scanner.
 *
 * Scans each path configured in `Project.skillDirectories` for `SKILL.md`
 * files and returns metadata for the ones not in `Project.disabledSkills`.
 * v1.1 supports filesystem paths only — git URLs are documented as future
 * work and rejected at write-time.
 *
 * The scanner is bounded: maximum directory depth, maximum entries per scan,
 * and a per-file size cap. This keeps a misconfigured directory from hanging
 * the session-start path.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createChildLogger } from "../logger.js";
import { resolveDataDir } from "../server-root.js";

const log = createChildLogger("skill-scanner");

const MAX_DEPTH = 4;
const MAX_ENTRIES = 500;
const MAX_FILE_BYTES = 256 * 1024;

export interface DiscoveredSkill {
  /** Slug matching the parent directory name. */
  slug: string;
  /** Absolute path to the `SKILL.md` file. */
  filePath: string;
  /** First non-empty line — used as the description in the UI. */
  excerpt: string;
  /** The directory the file was discovered under (one of the configured roots). */
  directorySource: string;
}

export interface ScanResult {
  skills: DiscoveredSkill[];
  /** Slugs explicitly skipped because they appear in `disabledSkills`. */
  disabled: string[];
  /** Roots that did not exist or could not be read. */
  errors: Array<{ root: string; error: string }>;
}

export class SkillDirectoryError extends Error {}

/**
 * Issue #1075 — the roots a skill directory may live under.
 *
 * Before #1075 any absolute path was accepted, which let whoever could reach
 * `POST /projects/:projectId/skill-directories` point the scanner at an
 * arbitrary server directory. The scanner is bounded but not harmless: it
 * walks four levels deep and returns the first prose line of every `SKILL.md`
 * it finds, so an out-of-root path is a filesystem-probing primitive.
 *
 * Configured with `SKILL_DIRECTORIES_ALLOWED_ROOTS` — one or more paths
 * separated by the platform path delimiter (`:` on POSIX, `;` on Windows).
 * Relative entries resolve against the server package root, exactly like every
 * other `data/` directory override. Unset defaults to `<server>/data/skills`,
 * i.e. fail-closed: a deployment that never configures a root can only add
 * directories inside METIS's own data tree.
 */
export function resolveAllowedSkillRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.SKILL_DIRECTORIES_ALLOWED_ROOTS?.trim();
  if (!raw) return [resolveDataDir(undefined, "skills")];
  const roots = raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => resolveDataDir(entry));
  return roots.length > 0 ? roots : [resolveDataDir(undefined, "skills")];
}

/**
 * True when `candidate` is `root` itself or lives beneath it. Uses
 * `path.relative` rather than a string prefix so `/srv/skills-evil` is not
 * treated as living under `/srv/skills`.
 *
 * Both sides are compared as normalized absolute paths. Symlinks are NOT
 * resolved here: the scanner's `readdir({ withFileTypes: true })` walk never
 * descends into symlinked directories (a symlink reports `isDirectory() ===
 * false`), so the only symlink that could widen the root is one an operator
 * placed at the root path itself.
 */
export function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/**
 * Validate a path entry. Currently only filesystem paths are supported. Git
 * URLs are rejected with a stable error code so the route layer can surface
 * a friendly message. Since #1075 the path must also resolve inside one of the
 * operator-configured roots (see `resolveAllowedSkillRoots`).
 */
export function validateDirectoryEntry(
  entry: unknown,
  allowedRoots: readonly string[] = resolveAllowedSkillRoots(),
): string {
  if (typeof entry !== "string" || entry.trim().length === 0) {
    throw new SkillDirectoryError("Directory entry must be a non-empty string");
  }
  const trimmed = entry.trim();
  if (/^(git\+|https?:\/\/|git@)/i.test(trimmed)) {
    throw new SkillDirectoryError(
      "Git-backed skill directories are not yet supported (planned for v1.2)",
    );
  }
  if (!path.isAbsolute(trimmed)) {
    throw new SkillDirectoryError("Directory entry must be an absolute path");
  }
  // Disallow path traversal sentinels in the absolute form. After `isAbsolute`
  // the only remaining concern is `..` segments, which we treat as suspicious.
  if (trimmed.split(path.sep).includes("..")) {
    throw new SkillDirectoryError("Directory entry must not contain '..'");
  }
  if (!allowedRoots.some((root) => isWithinRoot(root, trimmed))) {
    // Deliberately does not echo the configured roots — the GET route surfaces
    // validation errors to every project member, including readers.
    throw new SkillDirectoryError(
      "Directory entry is outside the allowed skill roots (see SKILL_DIRECTORIES_ALLOWED_ROOTS)",
    );
  }
  return trimmed;
}

export async function scanDirectory(root: string): Promise<DiscoveredSkill[]> {
  const out: DiscoveredSkill[] = [];
  await walk(root, root, 0, out);
  return out;
}

async function walk(
  root: string,
  current: string,
  depth: number,
  out: DiscoveredSkill[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  if (out.length > MAX_ENTRIES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(current, { withFileTypes: true });
  } catch (err) {
    log.debug("scan readdir failed", { current, error: (err as Error).message });
    return;
  }
  for (const entry of entries) {
    if (out.length > MAX_ENTRIES) return;
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden directories (.git, node_modules-like).
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      await walk(root, full, depth + 1, out);
    } else if (entry.isFile() && entry.name === "SKILL.md") {
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.size > MAX_FILE_BYTES) continue;
      const slug = path.basename(path.dirname(full));
      let excerpt = "";
      try {
        const text = await fs.readFile(full, "utf-8");
        excerpt = extractExcerpt(text);
      } catch {
        excerpt = "";
      }
      out.push({ slug, filePath: full, excerpt, directorySource: root });
    }
  }
}

function extractExcerpt(text: string): string {
  // Strip frontmatter fence if present.
  let body = text;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) body = text.slice(end + 4);
  }
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    return line.slice(0, 240);
  }
  return "";
}

export async function scan(
  directories: readonly string[],
  disabledSlugs: readonly string[] = [],
): Promise<ScanResult> {
  const disabled = new Set(disabledSlugs);
  const skills: DiscoveredSkill[] = [];
  const errors: Array<{ root: string; error: string }> = [];
  const skipped: string[] = [];
  // #1075 — re-validate at read time, not just at write time, so a directory
  // persisted before the allow-list existed (or after the roots were narrowed)
  // is reported as an error instead of being scanned.
  const allowedRoots = resolveAllowedSkillRoots();
  for (const dir of directories) {
    let resolved: string;
    try {
      resolved = validateDirectoryEntry(dir, allowedRoots);
    } catch (err) {
      errors.push({ root: dir, error: (err as Error).message });
      continue;
    }
    try {
      const found = await scanDirectory(resolved);
      for (const f of found) {
        if (disabled.has(f.slug)) {
          skipped.push(f.slug);
          continue;
        }
        skills.push(f);
      }
    } catch (err) {
      errors.push({ root: resolved, error: (err as Error).message });
    }
  }
  // Dedup by slug, last-wins.
  const bySlug = new Map<string, DiscoveredSkill>();
  for (const s of skills) bySlug.set(s.slug, s);
  return {
    skills: [...bySlug.values()],
    disabled: Array.from(new Set([...skipped, ...disabledSlugs])),
    errors,
  };
}
