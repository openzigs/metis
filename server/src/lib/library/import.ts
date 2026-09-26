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
 *      connector via Octokit. We never recurse arbitrary depth; the importer
 *      lists the root of the configured `path` (default `.github/skills/` or
 *      `.github/agents/`) and pulls each child SKILL.md / .agent.md.
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
  OVERSIZE_FILE_SENTINEL,
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
}

export interface ImportResult<T> {
  imported: T[];
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; error: string }>;
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
      // (the skill fails with a clear reason) instead of silently dropping it.
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
export interface RepoFetcher {
  /** List file entries (path + sha) under the root directory of the repo. */
  list(rootPath: string): Promise<Array<{ path: string; type: "file" | "dir" }>>;
  /** Fetch a single file's contents (utf-8). */
  read(filePath: string): Promise<string>;
}

export class RepoLoader implements ImportSourceLoader {
  constructor(
    private readonly fetcher: RepoFetcher,
    private readonly rootPath: string,
    private readonly originLabel: string,
    private readonly kind: "skills" | "agents",
  ) {}

  origin(): string {
    return `repo:${this.originLabel}`;
  }

  async load(): Promise<ImportFile[]> {
    const entries = await this.fetcher.list(this.rootPath);
    const out: ImportFile[] = [];
    for (const entry of entries) {
      if (entry.type !== "file") continue;
      if (!this.matches(entry.path)) continue;
      const contents = await this.fetcher.read(entry.path);
      out.push({ path: entry.path, contents });
    }
    return out;
  }

  private matches(p: string): boolean {
    const lower = p.toLowerCase();
    if (this.kind === "skills") {
      return lower.endsWith("/skill.md") || lower.endsWith(".skill.md");
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
    // #146 — an Agent Skills directory (SKILL.md + supporting files) is ONE
    // skill; any other file is a single-file skill, as before.
    for (const entry of groupSkillImport(files)) {
      try {
        const created = await this.skills.create(
          {
            source: entry.source,
            origin,
            ...(entry.files.length > 0 ? { files: entry.files } : {}),
          },
          actor,
        );
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
      },
    });
    return { imported, skipped, failed };
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
