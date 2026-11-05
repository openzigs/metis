/**
 * #1799 — materialize a localization corpus as real, ingested METIS projects,
 * so agent-based arms (#1755 A3, #1759) have something to search.
 *
 * The committed corpora are symbol rows and recorded vectors only. The
 * Analysis code agent's tools (`assembleAgenticCodeTools`) read a
 * database-ingested project, its symbol vectors and a clone at
 * `<REPO_CLONE_DIR>/<connectorId>`. `pnpm eval:materialize <corpus>` builds
 * exactly that, per repository: a clone at the pinned commit, a project with a
 * GitHub repository connector, the normal code-graph ingest and the local
 * embedder's symbol vectors, all inside a gitignored eval directory
 * ({@link materializeLayout}) and never in `server/dev.db`.
 *
 * This module is the testable half: the paths, the database guard, the
 * symbol-set check against the committed rows, the state file and the plan
 * that makes a re-run a no-op. The script (`server/scripts/eval-materialize.ts`)
 * supplies the I/O through {@link MaterializeDeps}.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  fileKey,
  localizationCorpusRoot,
  type LocalizationCorpusManifest,
  type LocalizationRepo,
  type LocalizationSymbolRow,
} from "./corpus.js";

/** Bumped when the state file's shape changes; an older state is rebuilt. */
export const MATERIALIZED_STATE_VERSION = 1;

/** The eval database's user: it owns the materialized projects and starts the A7 analyses (#1818). */
export const EVAL_USER_EMAIL = "eval-materialize@corpus.invalid";

/** Where everything a materialization writes lives. */
export interface MaterializeLayout {
  /** The gitignored eval directory (`eval-data/.materialized`). */
  root: string;
  /** The SQLite eval database. */
  databasePath: string;
  /** `file:<databasePath>`: what `DATABASE_URL` is set to. */
  databaseUrl: string;
  /** `REPO_CLONE_DIR`: one clone per connector, `<cloneRoot>/<connectorId>`. */
  cloneRoot: string;
  /** `LANCEDB_PATH`: the symbol vectors. */
  lancedbPath: string;
}

/** `<repo root>/eval-data/.materialized`. */
export function defaultMaterializeRoot(): string {
  return path.join(path.dirname(localizationCorpusRoot()), ".materialized");
}

/** `<repo root>/server/dev.db`, the database a materialization must never touch. */
export function devDatabasePath(): string {
  return path.resolve(path.dirname(localizationCorpusRoot()), "..", "server", "dev.db");
}

export function materializeLayout(root: string = defaultMaterializeRoot()): MaterializeLayout {
  const abs = path.resolve(root);
  const databasePath = path.join(abs, "eval.db");
  return {
    root: abs,
    databasePath,
    databaseUrl: `file:${databasePath}`,
    cloneRoot: path.join(abs, "clones"),
    lancedbPath: path.join(abs, "lancedb"),
  };
}

/** The state file of one corpus. */
export function statePathFor(layout: MaterializeLayout, corpus: string): string {
  return path.join(layout.root, `${corpus}.state.json`);
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Refuse any database but the eval one: a `file:` URL with an absolute path
 * inside the eval directory, and never `server/dev.db`. The dev database is a
 * `file:` URL too, so the scheme alone is no guard.
 */
export function assertEvalDatabase(
  databaseUrl: string,
  layout: MaterializeLayout,
  devDbPath: string = devDatabasePath(),
): void {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error(`eval database must be a SQLite file: URL, not ${JSON.stringify(databaseUrl)}`);
  }
  const file = databaseUrl.slice("file:".length);
  if (!path.isAbsolute(file)) {
    throw new Error(`eval database path must be absolute, not ${JSON.stringify(file)}`);
  }
  const resolved = path.resolve(file);
  if (resolved === path.resolve(devDbPath)) {
    throw new Error(`refusing to materialize into the dev database (${resolved})`);
  }
  if (!isInside(layout.root, resolved)) {
    throw new Error(`eval database ${resolved} is outside the eval directory ${layout.root}`);
  }
}

/** A path-safe id, fixed per corpus and repository, so a rebuild finds what it replaces. */
function evalKey(corpus: string, repo: string): string {
  const key = `eval-${corpus}-${repo}`;
  if (!/^[a-z0-9-]+$/.test(key)) throw new Error(`not a path-safe eval key: ${key}`);
  return key;
}

/** The repository connector's id: also the clone directory's name. */
export function connectorIdFor(corpus: string, repo: string): string {
  return evalKey(corpus, repo);
}

/** The project's slug (unique), so a rebuild deletes the project it replaces. */
export function projectSlugFor(corpus: string, repo: string): string {
  return evalKey(corpus, repo);
}

/** `https://github.com/<owner>/<name>`, and nothing else: the URL reaches `git`. */
export function parseGithubRepoUrl(url: string): { owner: string; name: string } {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m || m[1]!.startsWith("-") || m[2]!.startsWith("-")) {
    throw new Error(`not a https://github.com/<owner>/<name> URL: ${JSON.stringify(url)}`);
  }
  return { owner: m[1]!, name: m[2]! };
}

/** A full 40-hex commit id: the clone is fetched by it. */
export function assertCommitSha(sha: string): void {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`not a full commit SHA: ${JSON.stringify(sha)}`);
}

/** What the symbol-set check compares: the file and the qualified name. */
export interface SymbolKeyRow {
  filePath: string;
  qualifiedName: string;
}

/** One repository's difference between the committed rows and the materialized graph. */
export interface SymbolSetDiff {
  repo: string;
  /** `<repo>:<path>` in the committed rows, absent from the graph. */
  missingFiles: string[];
  /** `<repo>:<path>` in the graph, absent from the committed rows. */
  extraFiles: string[];
  /** `<repo>:<path>#<qualifiedName>` in a shared file, committed but not materialized. */
  missingSymbols: string[];
  /** `<repo>:<path>#<qualifiedName>` in a shared file, materialized but not committed. */
  extraSymbols: string[];
}

function symbolKeys(
  repo: string,
  rows: readonly SymbolKeyRow[],
): { files: Set<string>; symbols: Set<string> } {
  const files = new Set<string>();
  const symbols = new Set<string>();
  for (const r of rows) {
    const file = fileKey(repo, r.filePath);
    files.add(file);
    symbols.add(`${file}#${r.qualifiedName}`);
  }
  return { files, symbols };
}

const minus = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((x) => !b.has(x)).sort();

/**
 * Compare a repository's committed symbol rows with the materialized graph's:
 * the same files, and in each file the same qualified names. A symbol in a file
 * only one side holds is reported once, as that file.
 */
export function compareSymbolSets(
  repo: string,
  committed: readonly SymbolKeyRow[],
  materialized: readonly SymbolKeyRow[],
): SymbolSetDiff {
  const want = symbolKeys(repo, committed);
  const have = symbolKeys(repo, materialized);
  const shared = (key: string): boolean => {
    const file = key.slice(0, key.indexOf("#"));
    return want.files.has(file) && have.files.has(file);
  };
  return {
    repo,
    missingFiles: minus(want.files, have.files),
    extraFiles: minus(have.files, want.files),
    missingSymbols: minus(want.symbols, have.symbols).filter(shared),
    extraSymbols: minus(have.symbols, want.symbols).filter(shared),
  };
}

export function symbolSetDiffIsEmpty(d: SymbolSetDiff): boolean {
  return (
    d.missingFiles.length +
      d.extraFiles.length +
      d.missingSymbols.length +
      d.extraSymbols.length ===
    0
  );
}

/** Every difference, `limit` per list, for the failure message. */
export function formatSymbolSetDiffs(diffs: readonly SymbolSetDiff[], limit = 25): string {
  const lines: string[] = [];
  const list = (label: string, items: string[]): void => {
    if (items.length === 0) return;
    lines.push(`  ${label} (${items.length}):`);
    for (const x of items.slice(0, limit)) lines.push(`    - ${x}`);
    if (items.length > limit) lines.push(`    … and ${items.length - limit} more`);
  };
  for (const d of diffs) {
    if (symbolSetDiffIsEmpty(d)) continue;
    lines.push(`${d.repo}:`);
    list("files in the committed rows, missing from the materialized graph", d.missingFiles);
    list("files in the materialized graph, not in the committed rows", d.extraFiles);
    list("symbols committed, not materialized", d.missingSymbols);
    list("symbols materialized, not committed", d.extraSymbols);
  }
  return lines.join("\n");
}

/** One materialized repository, as the state file records it. */
export interface MaterializedRepo {
  name: string;
  url: string;
  sha: string;
  projectId: string;
  connectorId: string;
  /** `<cloneRoot>/<connectorId>`: where the analysis orchestrator looks for it. */
  cloneDir: string;
  symbols: number;
}

/**
 * The gitignored record of a corpus's materialization. An agent arm sets
 * `DATABASE_URL`, `REPO_CLONE_DIR` and `LANCEDB_PATH` from it and runs on each
 * repository's `projectId` / `connectorId`.
 */
export interface MaterializedState {
  version: number;
  corpus: string;
  databaseUrl: string;
  cloneRoot: string;
  lancedbPath: string;
  /** The local embedder's model the symbol vectors are tagged with. */
  embedModel: string;
  materializedAt: string;
  repos: MaterializedRepo[];
}

/** The environment a state is valid for. */
export type MaterializeEnv = Pick<
  MaterializedState,
  "databaseUrl" | "cloneRoot" | "lancedbPath" | "embedModel"
>;

const REPO_STRING_FIELDS = ["name", "url", "sha", "projectId", "connectorId", "cloneDir"] as const;
const STATE_STRING_FIELDS = [
  "corpus",
  "databaseUrl",
  "cloneRoot",
  "lancedbPath",
  "embedModel",
  "materializedAt",
] as const;

/** Parse a state file; a malformed one throws rather than being half-trusted. */
export function parseMaterializedState(text: string): MaterializedState {
  const s = JSON.parse(text) as Record<string, unknown>;
  const bad = (why: string): never => {
    throw new Error(`malformed materialization state: ${why}`);
  };
  if (!s || typeof s !== "object") bad("not an object");
  if (typeof s.version !== "number") bad("no version");
  for (const f of STATE_STRING_FIELDS) if (typeof s[f] !== "string") bad(`no ${f}`);
  if (!Array.isArray(s.repos)) bad("no repos");
  for (const r of s.repos as Array<Record<string, unknown>>) {
    for (const f of REPO_STRING_FIELDS) if (typeof r?.[f] !== "string") bad(`a repo has no ${f}`);
    if (typeof r.symbols !== "number") bad("a repo has no symbol count");
  }
  return s as unknown as MaterializedState;
}

/**
 * The state of a corpus's materialization, or null when it has none. The read
 * an agent arm makes before it runs.
 */
export async function readMaterializedState(
  corpus: string,
  layout: MaterializeLayout = materializeLayout(),
): Promise<MaterializedState | null> {
  let text: string;
  try {
    text = await fs.readFile(statePathFor(layout, corpus), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseMaterializedState(text);
}

/** What to do with one manifest repository. */
export type RepoPlan =
  | { action: "keep"; repo: LocalizationRepo; entry: MaterializedRepo }
  | { action: "build"; repo: LocalizationRepo; reason: string };

/**
 * Decide, from the state file alone, which repositories are already
 * materialized at the manifest's commit and which must be built. State repos
 * the manifest no longer names are dropped. The caller still probes every
 * `keep` against the database and disk ({@link MaterializeDeps.probe}).
 */
export function planMaterialization(
  manifest: Pick<LocalizationCorpusManifest, "id" | "repos">,
  state: MaterializedState | null,
  env: MaterializeEnv,
): { repos: RepoPlan[]; drop: MaterializedRepo[] } {
  let whole: string | null = null;
  if (!state) whole = "not materialized";
  else if (state.version !== MATERIALIZED_STATE_VERSION) whole = "state from another version";
  else if (state.corpus !== manifest.id) whole = `state is for ${state.corpus}`;
  else if (
    state.databaseUrl !== env.databaseUrl ||
    state.cloneRoot !== env.cloneRoot ||
    state.lancedbPath !== env.lancedbPath
  ) {
    whole = "the eval directory moved";
  } else if (state.embedModel !== env.embedModel) {
    whole = `embedded with ${state.embedModel}, not ${env.embedModel}`;
  }
  const previous = state?.repos ?? [];
  const byName = new Map(previous.map((r) => [r.name, r]));
  const repos: RepoPlan[] = manifest.repos.map((repo) => {
    const entry = byName.get(repo.name);
    if (whole) return { action: "build", repo, reason: whole };
    if (!entry) return { action: "build", repo, reason: "not materialized" };
    if (entry.sha !== repo.sha) {
      return { action: "build", repo, reason: `materialized at ${entry.sha}, not ${repo.sha}` };
    }
    if (entry.url !== repo.url) return { action: "build", repo, reason: "repository URL changed" };
    return { action: "keep", repo, entry };
  });
  const names = new Set(manifest.repos.map((r) => r.name));
  // A wholesale rebuild replaces every repository by its fixed slug and
  // connector id, so only a state repo the manifest no longer names is dropped.
  const drop = previous.filter((r) => !names.has(r.name));
  return { repos, drop };
}

/** The I/O a materialization needs; the script supplies the real one. */
export interface MaterializeDeps {
  /**
   * Is a recorded repository still intact (project, graph at its commit, clone
   * at its commit, every symbol embedded with the current model)? Null when it
   * is, else why not. Read-only.
   */
  probe(entry: MaterializedRepo): Promise<string | null>;
  /** Clone, create, ingest and embed one repository, replacing any earlier copy. */
  build(repo: LocalizationRepo): Promise<MaterializedRepo>;
  /** Delete a materialized repository's project, vectors and clone. */
  drop(entry: MaterializedRepo): Promise<void>;
  /** The materialized graph's symbols. */
  readSymbols(projectId: string): Promise<SymbolKeyRow[]>;
  writeState(state: MaterializedState): Promise<void>;
  now(): Date;
  log(line: string): void;
}

export interface MaterializeResult {
  /** False when the run was a no-op: nothing built, dropped or written. */
  changed: boolean;
  state: MaterializedState;
}

/**
 * Materialize one corpus. Idempotent: when the state file, the database and the
 * clones already hold every repository at its pinned commit, nothing is
 * written. The symbol-set check runs every time, so a no-op still proves the
 * graph matches the committed rows; a mismatch throws listing the differences,
 * and a repository built by this run is dropped rather than left behind.
 */
export async function materializeCorpus(input: {
  manifest: Pick<LocalizationCorpusManifest, "id" | "repos">;
  committedRows: readonly LocalizationSymbolRow[];
  state: MaterializedState | null;
  env: MaterializeEnv;
  deps: MaterializeDeps;
}): Promise<MaterializeResult> {
  const { manifest, deps } = input;
  for (const repo of manifest.repos) {
    parseGithubRepoUrl(repo.url);
    assertCommitSha(repo.sha);
  }
  const plan = planMaterialization(manifest, input.state, input.env);
  for (const entry of plan.drop) {
    deps.log(`${entry.name}: no longer in the manifest, dropping`);
    await deps.drop(entry);
  }
  const entries: MaterializedRepo[] = [];
  const built: MaterializedRepo[] = [];
  for (const step of plan.repos) {
    const reason = step.action === "build" ? step.reason : await deps.probe(step.entry);
    if (step.action === "keep" && reason === null) {
      deps.log(`${step.repo.name}@${step.repo.sha.slice(0, 8)}: up to date`);
      entries.push(step.entry);
      continue;
    }
    deps.log(`${step.repo.name}@${step.repo.sha.slice(0, 8)}: building (${reason})`);
    const entry = await deps.build(step.repo);
    built.push(entry);
    entries.push(entry);
  }

  const diffs: SymbolSetDiff[] = [];
  for (const entry of entries) {
    const committed = input.committedRows.filter((r) => r.repo === entry.name);
    if (committed.length === 0) {
      throw new Error(`the committed symbol rows hold nothing for ${entry.name}`);
    }
    const diff = compareSymbolSets(entry.name, committed, await deps.readSymbols(entry.projectId));
    diffs.push(diff);
    if (symbolSetDiffIsEmpty(diff)) {
      deps.log(`${entry.name}: symbol set matches the committed rows (${committed.length} rows)`);
    }
  }
  if (!diffs.every(symbolSetDiffIsEmpty)) {
    for (const entry of built) await deps.drop(entry);
    throw new Error(
      `${manifest.id}: the materialized graph does not match the committed symbol rows\n` +
        formatSymbolSetDiffs(diffs),
    );
  }

  const changed = built.length > 0 || plan.drop.length > 0;
  const state: MaterializedState = changed
    ? {
        version: MATERIALIZED_STATE_VERSION,
        corpus: manifest.id,
        ...input.env,
        materializedAt: deps.now().toISOString(),
        repos: entries,
      }
    : input.state!;
  if (changed) await deps.writeState(state);
  return { changed, state };
}
