/**
 * Library importers \u2014 hydrate Skills + Agents from external sources.
 *
 * Three sources are supported in v1:
 *
 *   1. **Inline / file paste** \u2014 a raw `---\n...\n---\nbody` string posted
 *      directly. The `SkillService.create` / `AgentService.create` calls
 *      handle this path natively, so this module mostly hosts the multi-file
 *      bulk importers below.
 *
 *   2. **Repo** \u2014 fetch a single file from a configured Phase 8 repo
 *      connector via Octokit. Agents: the importer lists the root of the
 *      configured `path` (default `.github/agents/`) and pulls each
 *      `.agent.md`. Skills (#237): it walks at most `REPO_SKILLS_MAX_DEPTH`
 *      levels and `REPO_MAX_LISTINGS` directories below the root and pulls
 *      each SKILL.md with its supporting files, bounded exactly like the
 *      filesystem loader; a path outside the root is never fetched.
 *
 *   3. **Filesystem auto-discovery** \u2014 read `.github/skills` and
 *      `.github/agents` from the configured workspace root at startup. Path
 *      traversal is rejected: every resolved candidate must remain under the
 *      configured root.
 *
 * All paths route through a small {@link ImportSourceLoader} interface so
 * tests can stub repo + filesystem layers without spinning up Octokit or
 * touching disk.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { audit } from "../audit/audit-service.js";
import {
  type AgentActorRef as ActorRef,
  type AgentDetail,
  type AgentService,
  AgentServiceError,
  getAgentService,
} from "./agent-service.js";
import {
  getSkillService,
  type SkillDetail,
  type SkillService,
  SkillServiceError,
} from "./skill-service.js";
import {
  groupSkillImport,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  OVERSIZE_FILE_SENTINEL,
  triageSkillFiles,
  unreadFileSentinel,
} from "../agent-runtime/skill-bundle.js";

export class LibraryImportError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "LibraryImportError";
  }
}

export interface ImportFile {
  /** Repo-relative or filesystem-relative path \u2014 used as the audit label. */
  path: string;
  contents: string;
}

export interface ImportSourceLoader {
  /** Return one or more SKILL.md / .agent.md files from the source. */
  load(): Promise<ImportFile[]>;
  /** Stable origin string (e.g. `repo:abcd123` or `filesystem:/abs/path`). */
  origin(): string;
  /**
   * #237 — entries the loader refused to read (a path outside its root, past
   * a walk limit), reported in the import result's `skipped`.
   */
  rejectedPaths?(): Array<{ path: string; reason: string }>;
}

export interface ImportResult<T> {
  imported: T[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
  /**
   * #146 — supporting files of an IMPORTED skill that were left out (binary,
   * OS metadata, an invalid name, past a limit, a credential): the skill still
   * imports with its SKILL.md and every valid file. Skills only.
   */
  skippedFiles?: Array<{ skill: string; path: string; reason: string }>;
}

// ── Loaders ────────────────────────────────────────────────────────────────

export class InlineLoader implements ImportSourceLoader {
  constructor(private readonly files: ImportFile[]) {}
  load(): Promise<ImportFile[]> {
    return Promise.resolve(this.files);
  }
  origin(): string {
    return "inline";
  }
}

/**
 * Filesystem loader. Reads every `*.md` (skills) or `*.agent.md` (agents)
 * file under the configured root directory. Rejects any candidate whose
 * resolved path escapes the root \u2014 belt-and-suspenders against malicious
 * symlinks or `..` traversal.
 */
export class FilesystemLoader implements ImportSourceLoader {
  constructor(
    private readonly root: string,
    private readonly kind: "skills" | "agents",
    private readonly fsImpl: typeof fs = fs,
    /**
     * Epic #129 (#146) — also read the supporting files of every Agent Skills
     * directory (a directory holding a `SKILL.md`): text files only, each at
     * most `MAX_SKILL_FILE_BYTES`, never through a symlink, never outside root.
     */
    private readonly opts: { supportingFiles?: boolean } = {},
  ) {
    if (!path.isAbsolute(root)) {
      throw new LibraryImportError(
        400,
        "INVALID_ROOT",
        "FilesystemLoader requires an absolute root path",
      );
    }
  }

  origin(): string {
    return `filesystem:${this.root}`;
  }

  async load(): Promise<ImportFile[]> {
    const root = path.resolve(this.root);
    const out: ImportFile[] = [];
    // #146 — candidate supporting files, read only if a SKILL.md claims them.
    const others: string[] = [];
    const skillDirs = new Set<string>();
    const stack: string[] = [root];
    const maxDepth = 4;
    const seen = new Set<string>();
    while (stack.length > 0) {
      const dir = stack.pop()!;
      if (seen.has(dir)) continue;
      seen.add(dir);
      const depthFromRoot = path.relative(root, dir).split(path.sep).filter(Boolean).length;
      if (depthFromRoot > maxDepth) continue;
      let entries: import("node:fs").Dirent[];
      try {
        entries = await this.fsImpl.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const candidate = path.resolve(dir, entry.name);
        // Path-containment check \u2014 reject anything that escapes the root.
        const containment = root === candidate || candidate.startsWith(`${root}${path.sep}`);
        if (!containment) continue;
        if (entry.isSymbolicLink()) continue; // never follow symlinks
        if (entry.isDirectory()) {
          stack.push(candidate);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!this.matches(entry.name)) {
          if (this.opts.supportingFiles && this.kind === "skills") others.push(candidate);
          continue;
        }
        if (entry.name.toLowerCase() === "skill.md") skillDirs.add(dir);
        const contents = await this.fsImpl.readFile(candidate, "utf8");
        out.push({ path: path.relative(root, candidate), contents });
      }
    }
    for (const candidate of others) {
      const claimed = [...skillDirs].some((d) => candidate.startsWith(`${d}${path.sep}`));
      if (!claimed) continue;
      const stat = await this.fsImpl.stat(candidate).catch(() => null);
      if (!stat) continue;
      // An oversize file is passed on as a sentinel so the import REPORTS it
      // (left out of the skill, with its reason) instead of silently dropping it.
      if (stat.size > MAX_SKILL_FILE_BYTES) {
        out.push({ path: path.relative(root, candidate), contents: OVERSIZE_FILE_SENTINEL });
        continue;
      }
      const contents = await this.fsImpl.readFile(candidate, "utf8");
      out.push({ path: path.relative(root, candidate), contents });
    }
    return out;
  }

  private matches(name: string): boolean {
    const lower = name.toLowerCase();
    if (this.kind === "skills") {
      return lower === "skill.md" || lower.endsWith(".skill.md");
    }
    return lower.endsWith(".agent.md");
  }
}

/**
 * Repo loader \u2014 pulls files via an injected fetch function. We deliberately
 * keep the fetch surface dependency-free so the actual Octokit + Phase 8
 * connector wiring can live in the route layer.
 */
export interface RepoEntry {
  path: string;
  /** Only `file` and `dir` are followed; a symlink or submodule is never read. */
  type: "file" | "dir" | (string & {});
  /** Size in bytes when the connector reports it (an oversize file is then never fetched). */
  size?: number;
}

export interface RepoFetcher {
  /** List the entries of ONE directory of the repo (repo-relative paths). */
  list(rootPath: string): Promise<RepoEntry[]>;
  /** Fetch a single file's contents (utf-8). */
  read(filePath: string): Promise<string>;
}

/**
 * #237 — how far and how wide a skills import walks a repository. A skill
 * directory sits at most two levels below the root and its supporting files at
 * most four below that (`normalizeSkillFilePath`), so six levels reach every
 * file a skill can store; the listing budget bounds the walk of a large or
 * hostile tree.
 */
export const REPO_SKILLS_MAX_DEPTH = 6;
export const REPO_MAX_LISTINGS = 256;

/** File types a skill never stores as text — reported without being fetched. */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|pdf|zip|gz|tgz|bz2|xz|7z|rar|tar|jar|war|class|exe|dll|so|dylib|bin|o|a|wasm|pyc|woff2?|ttf|otf|eot|mp3|mp4|m4a|wav|ogg|mov|avi|mkv|sqlite|db)$/i;

/** A clean repo-relative path (posix, no `.`/`..`/empty segments, not absolute). */
function cleanRepoPath(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024) return null;
  if (raw.includes("\\") || raw.includes("\0") || raw.startsWith("/") || /^[A-Za-z]:/.test(raw)) {
    return null;
  }
  const segments = raw.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return null;
  return raw;
}

export class RepoLoader implements ImportSourceLoader {
  private readonly rejected: Array<{ path: string; reason: string }> = [];

  constructor(
    private readonly fetcher: RepoFetcher,
    private readonly rootPath: string,
    private readonly originLabel: string,
    private readonly kind: "skills" | "agents",
  ) {}

  origin(): string {
    return `repo:${this.originLabel}`;
  }

  /** #237 — entries the walk refused (outside the root, unsafe paths, budget); reported by the import. */
  rejectedPaths(): Array<{ path: string; reason: string }> {
    return [...this.rejected];
  }

  async load(): Promise<ImportFile[]> {
    this.rejected.length = 0;
    const root = this.rootPath.replace(/^\.\//, "").replace(/\/+$/, "");
    if (root !== "" && !cleanRepoPath(root)) {
      throw new LibraryImportError(
        400,
        "INVALID_ROOT",
        "Repository import path is not a clean relative path",
      );
    }
    const within = (p: string): boolean => root === "" || p.startsWith(`${root}/`);
    const depthOf = (p: string): number =>
      (root === "" ? p : p.slice(root.length + 1)).split("/").length;
    const files: RepoEntry[] = [];
    // #237 — skills walk the tree (a SKILL.md lives in a directory beneath the
    // root); agents keep reading the root only, as before.
    const maxDepth = this.kind === "skills" ? REPO_SKILLS_MAX_DEPTH : 0;
    const seen = new Set<string>();
    const queue: string[] = [root];
    const listed = new Set<string>();
    while (queue.length > 0) {
      const dir = queue.shift()!;
      if (listed.has(dir)) continue;
      if (listed.size >= REPO_MAX_LISTINGS) {
        this.rejected.push({
          path: dir,
          reason: `not listed: past the ${REPO_MAX_LISTINGS}-directory limit`,
        });
        continue;
      }
      listed.add(dir);
      for (const entry of await this.fetcher.list(dir)) {
        const p = cleanRepoPath(entry.path);
        if (!p || !within(p)) {
          this.rejected.push({
            path: String(entry.path).slice(0, 200),
            reason: "outside the import root or not a clean relative path",
          });
          continue;
        }
        if (seen.has(p)) continue;
        seen.add(p);
        if (entry.type === "dir") {
          if (depthOf(p) <= maxDepth) queue.push(p);
          continue;
        }
        if (entry.type === "file") files.push({ ...entry, path: p });
      }
    }

    const out: ImportFile[] = [];
    const skillDirs: string[] = [];
    for (const f of files) {
      if (!this.matches(f.path)) continue;
      const base = f.path.slice(f.path.lastIndexOf("/") + 1).toLowerCase();
      if (this.kind === "skills" && base === "skill.md") {
        skillDirs.push(f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : "");
      }
      out.push({ path: f.path, contents: await this.fetcher.read(f.path) });
    }
    if (this.kind === "skills") out.push(...(await this.supportingFiles(files, skillDirs)));
    return out;
  }

  /**
   * #237 — every other file beneath a `SKILL.md` directory (the deepest one
   * owns it, as `groupSkillImport` decides). Bounded before anything is
   * fetched: a binary type, a reported size past `MAX_SKILL_FILE_BYTES`, or a
   * file past the skill's `MAX_SKILL_FILES` read budget is passed on as a
   * sentinel so the import REPORTS it. The import's triage applies every other
   * rule (a fetched file past the size limit included).
   */
  private async supportingFiles(files: RepoEntry[], skillDirs: string[]): Promise<ImportFile[]> {
    const dirs = [...skillDirs].sort((a, b) => b.length - a.length);
    const ownerOf = (p: string): string | undefined =>
      dirs.find((d) => d === "" || p.startsWith(`${d}/`));
    const reads = new Map<string, number>();
    const out: ImportFile[] = [];
    const candidates = files
      .filter((f) => !this.matches(f.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    for (const f of candidates) {
      const owner = ownerOf(f.path);
      if (owner === undefined) continue;
      if (BINARY_EXT.test(f.path)) {
        out.push({ path: f.path, contents: unreadFileSentinel("not a text file") });
        continue;
      }
      if (typeof f.size === "number" && f.size > MAX_SKILL_FILE_BYTES) {
        out.push({ path: f.path, contents: OVERSIZE_FILE_SENTINEL });
        continue;
      }
      const n = reads.get(owner) ?? 0;
      if (n >= MAX_SKILL_FILES) {
        out.push({
          path: f.path,
          contents: unreadFileSentinel(`not read: past the ${MAX_SKILL_FILES}-file limit`),
        });
        continue;
      }
      reads.set(owner, n + 1);
      // A fetched file past the size limit is left out by the import's triage.
      out.push({ path: f.path, contents: await this.fetcher.read(f.path) });
    }
    return out;
  }

  private matches(p: string): boolean {
    const lower = p.toLowerCase();
    if (this.kind === "skills") {
      return lower === "skill.md" || lower.endsWith("/skill.md") || lower.endsWith(".skill.md");
    }
    return lower.endsWith(".agent.md");
  }
}

// ── Bulk importer ──────────────────────────────────────────────────────────

export interface BulkImporterDeps {
  skillService?: SkillService;
  agentService?: AgentService;
}

export class LibraryImporter {
  private readonly skills: SkillService;
  private readonly agents: AgentService;

  constructor(deps: BulkImporterDeps = {}) {
    this.skills = deps.skillService ?? getSkillService();
    this.agents = deps.agentService ?? getAgentService();
  }

  async importSkills(
    loader: ImportSourceLoader,
    actor: ActorRef,
  ): Promise<ImportResult<SkillDetail>> {
    const files = await loader.load();
    const origin = loader.origin();
    const imported: SkillDetail[] = [];
    const skipped: ImportResult<SkillDetail>["skipped"] = [];
    const failed: ImportResult<SkillDetail>["failed"] = [];
    const skippedFiles: NonNullable<ImportResult<SkillDetail>["skippedFiles"]> = [];
    // #237 — what the loader refused to read is reported, never dropped.
    for (const r of loader.rejectedPaths?.() ?? []) skipped.push(r);
    // #146 — an Agent Skills directory (SKILL.md + supporting files) is ONE
    // skill; any other file is a single-file skill, as before. A supporting
    // file METIS cannot store is left out and reported — only an invalid
    // SKILL.md fails the skill.
    for (const entry of groupSkillImport(files)) {
      const { accepted, skipped: leftOut } = triageSkillFiles(entry.files);
      try {
        const created = await this.skills.create(
          {
            source: entry.source,
            origin,
            ...(accepted.length > 0 ? { files: accepted } : {}),
          },
          actor,
        );
        for (const f of leftOut) skippedFiles.push({ skill: entry.path, ...f });
        imported.push(created);
      } catch (err) {
        if (err instanceof SkillServiceError && err.code === "SKILL_KEY_EXISTS") {
          skipped.push({ path: entry.path, reason: err.message });
          continue;
        }
        failed.push({ path: entry.path, error: (err as Error).message });
      }
    }
    audit({
      actor: { id: actor.id },
      action: "skill.import",
      target: { type: "library_import", id: origin },
      metadata: {
        origin,
        importedCount: imported.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
        skippedFileCount: skippedFiles.length,
      },
    });
    return { imported, skipped, failed, skippedFiles };
  }

  async importAgents(
    loader: ImportSourceLoader,
    actor: ActorRef,
  ): Promise<ImportResult<AgentDetail>> {
    const files = await loader.load();
    const origin = loader.origin();
    const imported: AgentDetail[] = [];
    const skipped: ImportResult<AgentDetail>["skipped"] = [];
    const failed: ImportResult<AgentDetail>["failed"] = [];
    for (const file of files) {
      try {
        const created = await this.agents.create({ source: file.contents, origin }, actor);
        imported.push(created);
      } catch (err) {
        if (err instanceof AgentServiceError && err.code === "AGENT_KEY_EXISTS") {
          skipped.push({ path: file.path, reason: err.message });
          continue;
        }
        failed.push({ path: file.path, error: (err as Error).message });
      }
    }
    audit({
      actor: { id: actor.id },
      action: "agent.import",
      target: { type: "library_import", id: origin },
      metadata: {
        origin,
        importedCount: imported.length,
        skippedCount: skipped.length,
        failedCount: failed.length,
      },
    });
    return { imported, skipped, failed };
  }
}

// ── Auto-discovery ─────────────────────────────────────────────────────────

/**
 * Best-effort auto-discovery of skills + agents from the running METIS
 * workspace root. Call once during boot when
 * `LIBRARY_AUTO_DISCOVER_ROOT` is set. Failures never throw \u2014 they audit
 * a `library.autodiscover.failed` event and return an empty result.
 */
export async function autoDiscoverFromWorkspace(
  workspaceRoot: string,
  actor: ActorRef,
  deps: BulkImporterDeps = {},
): Promise<{ skills: ImportResult<SkillDetail>; agents: ImportResult<AgentDetail> }> {
  const importer = new LibraryImporter(deps);
  const empty = { imported: [], skipped: [], failed: [] };
  let skills: ImportResult<SkillDetail> = empty;
  let agents: ImportResult<AgentDetail> = empty;
  try {
    const skillsRoot = path.join(workspaceRoot, ".github", "skills");
    const skillsLoader = new FilesystemLoader(skillsRoot, "skills", fs, { supportingFiles: true });
    skills = await importer.importSkills(skillsLoader, actor);
  } catch (err) {
    audit({
      actor: { id: actor.id },
      action: "library.autodiscover.failed",
      target: { type: "library_autodiscover", id: workspaceRoot },
      metadata: { kind: "skills", error: (err as Error).message },
    });
  }
  try {
    const agentsRoot = path.join(workspaceRoot, ".github", "agents");
    const agentsLoader = new FilesystemLoader(agentsRoot, "agents");
    agents = await importer.importAgents(agentsLoader, actor);
  } catch (err) {
    audit({
      actor: { id: actor.id },
      action: "library.autodiscover.failed",
      target: { type: "library_autodiscover", id: workspaceRoot },
      metadata: { kind: "agents", error: (err as Error).message },
    });
  }
  return { skills, agents };
}
