/**
 * #1834 — the staleness slice of the localization eval: what happens to arm A7
 * (`IMPACT_AGENT_SEEDS`, #1759) when the code its stored citations point at
 * has changed since the analysis, with and without #1832's demotion of stale
 * citations.
 *
 * Staleness is SYNTHETIC and committed: per item, a patch that edits one
 * function, renames one file and deletes one file in the materialized clone
 * (`pnpm eval:materialize`, #1799). The patch sets live next to the eval
 * script (`server/scripts/eval-localization-staleness/<corpus>.json`) and are
 * applied by the script, never by hand. The cycle per item is:
 *
 *   1. apply the item's patch to the clone and commit it there;
 *   2. re-ingest the clone (incremental), which re-validates the stored
 *      citations against the new graph (#1831): `fresh`, `moved` or `stale`;
 *   3. read impact analysis on the analysis's requirements;
 *   4. restore the clone to its pinned commit, re-ingest again and embed the
 *      re-created symbols, so the next analysis searches what A7 searched.
 *
 * Which files a model cites is not known when the patch is written, so the
 * targets are chosen from committed data by {@link generateStalenessPatchSet}:
 * the edit goes into the first ground-truth file (the file the analysis is
 * most likely to cite), the rename takes a second ground-truth file, and the
 * delete a non-answer neighbour. Every reading reports how many citations the
 * patch actually made stale or moved, so a patch that missed is visible.
 *
 * This module is pure apart from {@link applyOpsToClone}, whose file I/O is a
 * seam; the git and ingest calls live in the script.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocumentationFilePath, isTestFilePath } from "../../analysis/traceability-matrix.js";
import type {
  SeedSearcher,
  SeedSymbolLoader,
  SeedSymbolRow,
  StoredLinkRow,
} from "../../impact-analysis/change-seeds.js";
import { fileKey, type LocalizationSymbolRow } from "./corpus.js";
import { stableDigest } from "./partials.js";

/** The issue a patch set was written for: a set for another issue is refused. */
export const STALENESS_ISSUE = 1834;

/** The line an edit inserts (after the language's comment marker). */
export const STALENESS_EDIT_TEXT = "metis-eval #1834: synthetic staleness edit";

/** One change to one materialized repository. */
export type StalenessOp =
  /** Insert `text` as a new line after line `afterLine` (1-based), inside `symbol`. */
  | { op: "edit"; repo: string; file: string; symbol: string; afterLine: number; text: string }
  | { op: "rename"; repo: string; from: string; to: string }
  | { op: "delete"; repo: string; file: string };

/** A corpus's committed patch set: one list of operations per item. */
export interface StalenessPatchSet {
  corpus: string;
  issue: typeof STALENESS_ISSUE;
  /** How the targets were chosen, in words. */
  rule: string;
  items: Record<string, StalenessOp[]>;
}

/** The file paths an operation touches, in its repository. */
export function opFiles(op: StalenessOp): string[] {
  return op.op === "rename" ? [op.from, op.to] : [op.file];
}

/**
 * A repository-relative path the patch may touch: POSIX, normalized, inside
 * the repository. The path reaches the file system, so anything else throws.
 */
export function assertSafeRepoPath(p: unknown): asserts p is string {
  const ok =
    typeof p === "string" &&
    p.length > 0 &&
    !p.includes("\\") &&
    !p.includes("\0") &&
    !p.startsWith("/") &&
    !p.startsWith("-") &&
    path.posix.normalize(p) === p &&
    p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
  if (!ok) throw new Error(`not a safe repository path: ${JSON.stringify(p)}`);
}

const REPO_NAME = /^[a-z0-9][a-z0-9-]*$/;

function parseOp(raw: unknown, where: string): StalenessOp {
  const bad = (why: string): never => {
    throw new Error(`malformed staleness patch (${where}): ${why}`);
  };
  if (!raw || typeof raw !== "object") bad("not an object");
  const o = raw as Record<string, unknown>;
  if (typeof o.repo !== "string" || !REPO_NAME.test(o.repo)) bad("no repo");
  const repo = o.repo as string;
  if (o.op === "edit") {
    assertSafeRepoPath(o.file);
    if (typeof o.symbol !== "string" || o.symbol === "") bad("an edit names no symbol");
    if (!Number.isInteger(o.afterLine) || (o.afterLine as number) < 1) bad("no afterLine");
    if (typeof o.text !== "string" || o.text === "" || /[\r\n]/.test(o.text)) {
      bad("an edit's text must be one non-empty line");
    }
    return {
      op: "edit",
      repo,
      file: o.file,
      symbol: o.symbol as string,
      afterLine: o.afterLine as number,
      text: o.text as string,
    };
  }
  if (o.op === "rename") {
    assertSafeRepoPath(o.from);
    assertSafeRepoPath(o.to);
    if (o.from === o.to) bad("a rename to itself");
    return { op: "rename", repo, from: o.from, to: o.to };
  }
  if (o.op === "delete") {
    assertSafeRepoPath(o.file);
    return { op: "delete", repo, file: o.file };
  }
  return bad(`unknown op ${JSON.stringify(o.op)}`);
}

/**
 * A file is touched by one rename, one delete, or edits only, and never two
 * edits after the same line: otherwise the operations' order would matter.
 */
function assertDisjoint(ops: readonly StalenessOp[], where: string): void {
  const seen = new Map<string, "edit" | "other">();
  const lines = new Set<string>();
  for (const op of ops) {
    for (const f of opFiles(op)) {
      const key = fileKey(op.repo, f);
      const kind = op.op === "edit" ? "edit" : "other";
      if (seen.has(key) && (kind === "other" || seen.get(key) === "other")) {
        throw new Error(`malformed staleness patch (${where}): ${key} is touched twice`);
      }
      seen.set(key, kind);
      if (op.op === "edit") {
        const line = `${key}#${op.afterLine}`;
        if (lines.has(line)) {
          throw new Error(
            `malformed staleness patch (${where}): two edits after line ${op.afterLine} of ${key}`,
          );
        }
        lines.add(line);
      }
    }
  }
}

/** Parse a committed patch set; a malformed one throws rather than being half-applied. */
export function parseStalenessPatchSet(text: string): StalenessPatchSet {
  const s = JSON.parse(text) as Record<string, unknown>;
  if (!s || typeof s !== "object") throw new Error("malformed staleness patch set: not an object");
  if (typeof s.corpus !== "string") throw new Error("malformed staleness patch set: no corpus");
  if (s.issue !== STALENESS_ISSUE) {
    throw new Error(`malformed staleness patch set: written for issue ${String(s.issue)}`);
  }
  if (typeof s.rule !== "string") throw new Error("malformed staleness patch set: no rule");
  if (!s.items || typeof s.items !== "object" || Array.isArray(s.items)) {
    throw new Error("malformed staleness patch set: no items");
  }
  const items: Record<string, StalenessOp[]> = {};
  for (const [id, ops] of Object.entries(s.items as Record<string, unknown>)) {
    if (!Array.isArray(ops) || ops.length === 0) {
      throw new Error(`malformed staleness patch (${id}): no operations`);
    }
    items[id] = ops.map((op, i) => parseOp(op, `${id}[${i}]`));
    assertDisjoint(items[id]!, id);
  }
  return { corpus: s.corpus, issue: STALENESS_ISSUE, rule: s.rule, items };
}

/** `server/scripts/eval-localization-staleness`: the committed patch sets, one file per corpus. */
export function stalenessPatchDir(): string {
  // server/src/lib/eval/localization → server/scripts is four levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../scripts/eval-localization-staleness");
}

/** Every committed patch set, by corpus; a file named for another corpus is refused. */
export async function loadStalenessPatchSets(
  dir: string = stalenessPatchDir(),
): Promise<Map<string, StalenessPatchSet>> {
  const out = new Map<string, StalenessPatchSet>();
  const names = (await fs.readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  for (const name of names) {
    const set = parseStalenessPatchSet(await fs.readFile(path.join(dir, name), "utf8"));
    if (`${set.corpus}.json` !== name)
      throw new Error(`${name} holds the patch set of ${set.corpus}`);
    out.set(set.corpus, set);
  }
  return out;
}

/** One digest over every patch set: a resume or merge under other patches is refused. */
export function patchSetsDigest(sets: ReadonlyMap<string, StalenessPatchSet>): string {
  return stableDigest([...sets.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/** What target selection reads of a corpus symbol (or of a materialized graph's). */
export interface PatchSymbolRow {
  repo: string;
  filePath: string;
  qualifiedName: string;
  kind: string;
  language: string;
  startLine: number;
  endLine: number;
}

/** What target selection reads of an item: its id and ground-truth files (`<repo>:<path>`). */
export interface PatchTargetItem {
  id: string;
  expectedFiles: readonly string[];
  /** Symbol names the item's answer names (the table corpus's labels): edited first. */
  expectedSymbols?: readonly string[];
}

/** A qualified name's last segment: `a.go::T::m` and `org.x.T.m` both give `m`. */
const simpleName = (qualifiedName: string): string =>
  qualifiedName.split("::").pop()!.split(".").pop()!;

const HASH_COMMENT_LANGUAGES: ReadonlySet<string> = new Set([
  "py",
  "python",
  "rb",
  "ruby",
  "sh",
  "bash",
  "yaml",
  "yml",
  "toml",
  "r",
]);

/** The edit's line, as a comment of the language. */
export function commentLineFor(language: string): string {
  const lang = language.toLowerCase();
  if (HASH_COMMENT_LANGUAGES.has(lang)) return `# ${STALENESS_EDIT_TEXT}`;
  if (lang.includes("xml") || lang === "html") return `<!-- ${STALENESS_EDIT_TEXT} -->`;
  if (lang === "sql") return `-- ${STALENESS_EDIT_TEXT}`;
  return `// ${STALENESS_EDIT_TEXT}`;
}

/** Kinds an edit prefers: a body the analysis cites by symbol. */
const PREFERRED_EDIT_KINDS: ReadonlySet<string> = new Set(["function", "method"]);
/** Kinds that are not a code body: never edited. */
const NEVER_EDITED_KINDS: ReadonlySet<string> = new Set(["module", "table", "column", "view"]);

/** `dir/name_renamed.ext` (or `dir/name_renamed` without an extension). */
export function renamedPath(p: string): string {
  const ext = path.posix.extname(p);
  const stem = ext ? p.slice(0, -ext.length) : p;
  return `${stem}_renamed${ext}`;
}

function splitKey(key: string): { repo: string; file: string } {
  const i = key.indexOf(":");
  if (i <= 0) throw new Error(`not a <repo>:<path> file key: ${key}`);
  return { repo: key.slice(0, i), file: key.slice(i + 1) };
}

/** Directories apart in the tree: 0 for the same directory, 1 for a parent or a child. */
export function directoryDistance(a: string, b: string): number {
  const x = a === "." ? [] : a.split("/");
  const y = b === "." ? [] : b.split("/");
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  return x.length - n + (y.length - n);
}

/**
 * The rule every committed patch set is generated with, per item:
 *
 *   - edit: in the first ground-truth file that has one, every multi-line
 *     symbol the item's labels name (the table corpus's `expectedCodeSymbols`);
 *     else every multi-line function and method of the first that has one;
 *     else the longest other multi-line, non-module symbol. Each gets one
 *     comment line after its first line, inside the symbol, so its content
 *     hash changes and its location does not. Every function, not one: which
 *     function the analysis cites is not known, and an edit to a function it
 *     did not cite leaves nothing stale (the first DeepSeek reading, MF-4483);
 *   - rename: the first other ground-truth file (any repository), else the
 *     neighbour of the edited file (below) with the most symbols, to
 *     `<name>_renamed<ext>`;
 *   - delete: the edited file's neighbour with the most symbols, other than
 *     the renamed one: a code file of the same repository, not an answer, not
 *     a test or documentation file, in the directory nearest the edited
 *     file's (its own first). No answer file is ever deleted: an item whose answer
 *     is gone could not be scored.
 *
 * Files are compared as the graph holds them; an item with no editable
 * ground-truth file is left out (and so refused by the preflight).
 */
export const STALENESS_RULE =
  "edit: one comment line inside every multi-line symbol the item's labels name, else inside every multi-line " +
  "function/method, else inside the longest other multi-line non-module symbol, of the first ground-truth file " +
  "that has one of that tier; rename: " +
  "the first other ground-truth file, else the edited " +
  "file's neighbour with the most symbols, to <name>_renamed<ext>; delete: the edited file's " +
  "neighbour with the most symbols (same repository, nearest directory, never an answer, " +
  "a test or a documentation file)";

export function generateStalenessPatchSet(input: {
  corpus: string;
  items: readonly PatchTargetItem[];
  symbols: readonly PatchSymbolRow[];
}): StalenessPatchSet {
  const byFile = new Map<string, PatchSymbolRow[]>();
  for (const r of input.symbols) {
    const key = fileKey(r.repo, r.filePath);
    byFile.set(key, [...(byFile.get(key) ?? []), r]);
  }
  /**
   * The file's editable symbols of a tier, in line order: 0, every one the
   * item names; 1, every function and method; 2, the longest other
   * multi-line, non-module symbol. One per first line.
   */
  const editSymbols = (
    key: string,
    tier: 0 | 1 | 2,
    named: ReadonlySet<string>,
  ): PatchSymbolRow[] => {
    const rows = (byFile.get(key) ?? []).filter(
      (r) =>
        !NEVER_EDITED_KINDS.has(r.kind) &&
        r.endLine > r.startLine &&
        (tier === 2 ||
          (tier === 1 && PREFERRED_EDIT_KINDS.has(r.kind)) ||
          (tier === 0 && named.has(simpleName(r.qualifiedName)))),
    );
    if (tier === 2) {
      const longest = [...rows].sort(
        (a, b) =>
          b.endLine - b.startLine - (a.endLine - a.startLine) ||
          a.startLine - b.startLine ||
          a.qualifiedName.localeCompare(b.qualifiedName),
      )[0];
      return longest ? [longest] : [];
    }
    const byLine = new Map<number, PatchSymbolRow>();
    for (const r of [...rows].sort(
      (a, b) => a.startLine - b.startLine || a.qualifiedName.localeCompare(b.qualifiedName),
    )) {
      if (!byLine.has(r.startLine)) byLine.set(r.startLine, r);
    }
    return [...byLine.values()];
  };
  const items: Record<string, StalenessOp[]> = {};
  for (const item of input.items) {
    const gold = item.expectedFiles.filter((f) => byFile.has(f));
    // A symbol the answer names first, then a function or method body, then
    // any other body: in the first answer file that has one of the tier.
    const named = new Set(item.expectedSymbols ?? []);
    let syms: PatchSymbolRow[] = [];
    let editKey: string | undefined;
    for (const tier of [0, 1, 2] as const) {
      editKey = gold.find((f) => editSymbols(f, tier, named).length > 0);
      if (editKey) {
        syms = editSymbols(editKey, tier, named);
        break;
      }
    }
    if (!editKey || syms.length === 0) continue;
    const edit = splitKey(editKey);
    const answers = new Set(item.expectedFiles);
    const dir = path.posix.dirname(edit.file);
    const neighbours = [...byFile.keys()]
      .filter((k) => !answers.has(k))
      .map(splitKey)
      .filter(
        (f) => f.repo === edit.repo && !isTestFilePath(f.file) && !isDocumentationFilePath(f.file),
      )
      .sort(
        (a, b) =>
          directoryDistance(path.posix.dirname(a.file), dir) -
            directoryDistance(path.posix.dirname(b.file), dir) ||
          byFile.get(fileKey(b.repo, b.file))!.length -
            byFile.get(fileKey(a.repo, a.file))!.length ||
          a.file.localeCompare(b.file),
      );
    const ops: StalenessOp[] = syms.map((sym) => ({
      op: "edit",
      repo: edit.repo,
      file: edit.file,
      symbol: sym.qualifiedName,
      afterLine: sym.startLine,
      text: commentLineFor(sym.language),
    }));
    // A second answer file is renamed; else the nearest neighbour (an answer is never a neighbour).
    const secondGold = gold.find((f) => f !== editKey);
    const renameFrom = secondGold ? splitKey(secondGold) : neighbours.shift();
    if (renameFrom) {
      const to = renamedPath(renameFrom.file);
      if (!byFile.has(fileKey(renameFrom.repo, to))) {
        ops.push({ op: "rename", repo: renameFrom.repo, from: renameFrom.file, to });
      }
    }
    const del = neighbours[0];
    if (del) ops.push({ op: "delete", repo: del.repo, file: del.file });
    items[item.id] = ops;
  }
  return { corpus: input.corpus, issue: STALENESS_ISSUE, rule: STALENESS_RULE, items };
}

/**
 * Check a patch set against the corpus it is applied to: every item has a
 * patch, every touched file is a file of the graph (a rename's target is
 * not), and every edit's line is inside its symbol. Returns the problems.
 */
export function stalenessPatchProblems(
  set: StalenessPatchSet,
  corpus: { name: string; itemIds: readonly string[]; symbols: readonly PatchSymbolRow[] },
): string[] {
  const out: string[] = [];
  if (set.corpus !== corpus.name)
    out.push(`the patch set is for ${set.corpus}, not ${corpus.name}`);
  const files = new Set(corpus.symbols.map((r) => fileKey(r.repo, r.filePath)));
  for (const id of corpus.itemIds) {
    const ops = set.items[id];
    if (!ops) {
      out.push(`${id}: no staleness patch`);
      continue;
    }
    for (const op of ops) {
      if (op.op === "rename") {
        if (!files.has(fileKey(op.repo, op.from)))
          out.push(`${id}: ${op.repo}:${op.from} is not in the graph`);
        if (files.has(fileKey(op.repo, op.to)))
          out.push(`${id}: ${op.repo}:${op.to} already exists`);
        continue;
      }
      if (!files.has(fileKey(op.repo, op.file))) {
        out.push(`${id}: ${op.repo}:${op.file} is not in the graph`);
        continue;
      }
      if (op.op === "edit") {
        const sym = corpus.symbols.find(
          (r) => r.repo === op.repo && r.filePath === op.file && r.qualifiedName === op.symbol,
        );
        if (!sym) out.push(`${id}: no symbol ${op.symbol} in ${op.repo}:${op.file}`);
        else if (op.afterLine < sym.startLine || op.afterLine >= sym.endLine) {
          out.push(
            `${id}: line ${op.afterLine} is not inside ${op.symbol} (${sym.startLine}-${sym.endLine})`,
          );
        }
      }
    }
  }
  for (const id of Object.keys(set.items)) {
    if (!corpus.itemIds.includes(id)) out.push(`${id}: not an item of ${corpus.name}`);
  }
  return out;
}

/** The repositories an item's patch touches, in first-touch order. */
export function patchedRepos(ops: readonly StalenessOp[]): string[] {
  return [...new Set(ops.map((o) => o.repo))];
}

/**
 * The graph after the patch, for the stage's graph-membership check: a
 * renamed file's symbols under the new path, a deleted file's gone.
 */
export function patchedFileSymbols(
  base: (filePaths: string[], repo: string) => Promise<SeedSymbolRow[]>,
  ops: readonly StalenessOp[],
): (filePaths: string[], repo: string) => Promise<SeedSymbolRow[]> {
  return async (filePaths, repo) => {
    const renamedTo = new Map<string, string>();
    const gone = new Set<string>();
    for (const op of ops) {
      if (op.repo !== repo) continue;
      if (op.op === "rename") {
        renamedTo.set(op.to, op.from);
        gone.add(op.from);
      } else if (op.op === "delete") gone.add(op.file);
    }
    const ask = new Map<string, string>();
    for (const p of filePaths) {
      if (renamedTo.has(p)) ask.set(renamedTo.get(p)!, p);
      else if (!gone.has(p)) ask.set(p, p);
    }
    if (ask.size === 0) return [];
    const rows = await base([...ask.keys()], repo);
    return rows.flatMap((r) =>
      ask.has(r.filePath) ? [{ ...r, filePath: ask.get(r.filePath)! }] : [],
    );
  };
}

/**
 * Scored files (`<repo>:<path>`) as the corpus names them: a renamed file is
 * scored as the file it was, so a renamed answer is still found. Order kept,
 * duplicates dropped.
 */
export function unrenamedFiles(files: readonly string[], ops: readonly StalenessOp[]): string[] {
  const back = new Map(
    ops.flatMap((o) =>
      o.op === "rename" ? [[fileKey(o.repo, o.to), fileKey(o.repo, o.from)]] : [],
    ),
  );
  return [...new Set(files.map((f) => back.get(f) ?? f))];
}

/**
 * The corpus's symbol rows after the patch, for the staleness arms' search: a
 * deleted file's rows are gone, and a renamed file's rows carry the new path in
 * their file, their qualified name's file root and their embedding text (so
 * they are embedded again, as a re-ingest would). An edited symbol keeps its
 * row: one comment line is not worth a new vector.
 */
export function patchedSymbolRows(
  rows: readonly LocalizationSymbolRow[],
  ops: readonly StalenessOp[],
): LocalizationSymbolRow[] {
  const renamed = new Map<string, string>();
  const gone = new Set<string>();
  for (const op of ops) {
    if (op.op === "rename") renamed.set(fileKey(op.repo, op.from), op.to);
    else if (op.op === "delete") gone.add(fileKey(op.repo, op.file));
  }
  return rows.flatMap((r) => {
    const key = fileKey(r.repo, r.filePath);
    if (gone.has(key)) return [];
    const to = renamed.get(key);
    if (to === undefined) return [r];
    const from = r.filePath;
    return [
      {
        ...r,
        filePath: to,
        qualifiedName: r.qualifiedName.startsWith(from)
          ? to + r.qualifiedName.slice(from.length)
          : r.qualifiedName,
        ...(r.embeddingText !== undefined
          ? { embeddingText: r.embeddingText.split(from).join(to) }
          : {}),
      },
    ];
  });
}

/**
 * A search that no longer finds the given files (the table guard's fixture
 * search, after a patch deleted them): their hits and symbol rows are dropped.
 */
export function searchWithoutFiles<
  S extends { searcher: SeedSearcher; loadSymbols: SeedSymbolLoader },
>(search: S, gone: ReadonlySet<string>): S {
  if (gone.size === 0) return search;
  return {
    ...search,
    searcher: {
      search: async (query, projectId, opts) =>
        (await search.searcher.search(query, projectId, opts)).filter((h) => !gone.has(h.filePath)),
    },
    loadSymbols: async (ids, projectId) =>
      (await search.loadSymbols(ids, projectId)).filter((r) => !gone.has(r.filePath)),
  };
}

/** The graph's files after the patch (`<repo>:<path>`). */
export function patchedGraphFiles(
  graphFiles: ReadonlySet<string>,
  ops: readonly StalenessOp[],
): Set<string> {
  const out = new Set(graphFiles);
  for (const op of ops) {
    if (op.op === "rename") {
      out.delete(fileKey(op.repo, op.from));
      out.add(fileKey(op.repo, op.to));
    } else if (op.op === "delete") out.delete(fileKey(op.repo, op.file));
  }
  return out;
}

/**
 * #1834 — the stage BEFORE #1832, for the "without demotion" readings: the
 * same stored citations with their freshness hidden, so the stage neither sets
 * a stale one aside nor orders by freshness tier (every row reads as never
 * checked, and the order is confidence, then citation order, as #1818 shipped).
 */
export function withoutFreshness(
  load: (requirementId: string, projectId: string) => Promise<StoredLinkRow[]>,
): (requirementId: string, projectId: string) => Promise<StoredLinkRow[]> {
  return async (requirementId, projectId) =>
    (await load(requirementId, projectId)).map((link) => {
      const { freshness: _hidden, ...rest } = link;
      return rest;
    });
}

/** How many of a reading's stored citations re-validation left in each state. */
export interface FreshnessTally {
  fresh: number;
  moved: number;
  stale: number;
  unverified: number;
}

export function tallyFreshness(links: readonly StoredLinkRow[], into: FreshnessTally): void {
  for (const l of links) {
    if (l.freshness === "fresh") into.fresh++;
    else if (l.freshness === "moved") into.moved++;
    else if (l.freshness === "stale") into.stale++;
    else into.unverified++;
  }
}

export const emptyTally = (): FreshnessTally => ({ fresh: 0, moved: 0, stale: 0, unverified: 0 });

/** File I/O {@link applyOpsToClone} needs; node's by default. */
export interface CloneFiles {
  readFile(p: string): Promise<string>;
  writeFile(p: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(p: string): Promise<void>;
  exists(p: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
}

export const nodeCloneFiles: CloneFiles = {
  readFile: (p) => fs.readFile(p, "utf8"),
  writeFile: (p, text) => fs.writeFile(p, text, "utf8"),
  rename: (from, to) => fs.rename(from, to),
  remove: (p) => fs.rm(p),
  exists: async (p) =>
    fs.stat(p).then(
      () => true,
      () => false,
    ),
  mkdirp: async (dir) => {
    await fs.mkdir(dir, { recursive: true });
  },
};

/** A repository path inside the clone; anything that escapes it throws. */
export function resolveInClone(cloneDir: string, rel: string): string {
  assertSafeRepoPath(rel);
  const root = path.resolve(cloneDir);
  const abs = path.resolve(root, rel);
  const back = path.relative(root, abs);
  if (back === "" || back.startsWith("..") || path.isAbsolute(back)) {
    throw new Error(`${rel} escapes the clone ${root}`);
  }
  return abs;
}

/**
 * Apply one repository's operations to its clone's working tree: edits (of a
 * file, bottom-up, so each line number still holds), then renames, then
 * deletes. Each is checked first (the file is there, a rename's target is
 * not, the edit's line exists), so a stale patch fails loudly.
 */
export async function applyOpsToClone(
  cloneDir: string,
  ops: readonly StalenessOp[],
  files: CloneFiles = nodeCloneFiles,
): Promise<void> {
  const order = { edit: 0, rename: 1, delete: 2 } as const;
  const line = (op: StalenessOp) => (op.op === "edit" ? op.afterLine : 0);
  for (const op of [...ops].sort((a, b) => order[a.op] - order[b.op] || line(b) - line(a))) {
    if (op.op === "edit") {
      const abs = resolveInClone(cloneDir, op.file);
      const text = await files.readFile(abs);
      const eol = text.includes("\r\n") ? "\r\n" : "\n";
      const lines = text.split(eol);
      if (op.afterLine > lines.length) {
        throw new Error(
          `${op.file} has ${lines.length} lines; cannot edit after line ${op.afterLine}`,
        );
      }
      lines.splice(op.afterLine, 0, op.text);
      await files.writeFile(abs, lines.join(eol));
    } else if (op.op === "rename") {
      const from = resolveInClone(cloneDir, op.from);
      const to = resolveInClone(cloneDir, op.to);
      if (!(await files.exists(from)))
        throw new Error(`cannot rename ${op.from}: not in the clone`);
      if (await files.exists(to)) throw new Error(`cannot rename to ${op.to}: it exists`);
      await files.mkdirp(path.dirname(to));
      await files.rename(from, to);
    } else {
      const abs = resolveInClone(cloneDir, op.file);
      if (!(await files.exists(abs))) throw new Error(`cannot delete ${op.file}: not in the clone`);
      await files.remove(abs);
    }
  }
}

/** What one patch cycle needs per repository; the script supplies git and the ingest. */
export interface StalenessCycleDeps<R> {
  /** Apply the repository's operations to its clone and commit them; the new commit. */
  applyAndCommit(repo: R, ops: readonly StalenessOp[]): Promise<string>;
  /** Put the clone back at its pinned commit, working tree clean. */
  restore(repo: R): Promise<void>;
  /** Incremental re-ingest of the clone as `commitSha` (re-validates the citations, #1831). */
  reingest(repo: R, commitSha: string): Promise<void>;
  /** The pinned commit a repository is restored to. */
  pinnedSha(repo: R): string;
  /**
   * After the restoring re-ingest: the re-parsed files' symbols are new rows,
   * so the script embeds them again, or a later analysis's vector search
   * would miss the files an earlier patch touched.
   */
  afterRestore?(repo: R): Promise<void>;
}

/**
 * Apply an item's patch, re-ingest, run `read`, then restore and re-ingest
 * every repository it touched, whether `read` (or the patch) failed or not.
 */
export async function withStalePatch<R, T>(
  ops: readonly StalenessOp[],
  repoOf: (name: string) => R,
  deps: StalenessCycleDeps<R>,
  read: () => Promise<T>,
): Promise<T> {
  const touched: R[] = [];
  try {
    for (const name of patchedRepos(ops)) {
      const repo = repoOf(name);
      touched.push(repo);
      const sha = await deps.applyAndCommit(
        repo,
        ops.filter((o) => o.repo === name),
      );
      await deps.reingest(repo, sha);
    }
    return await read();
  } finally {
    for (const repo of touched) {
      await deps.restore(repo);
      await deps.reingest(repo, deps.pinnedSha(repo));
      await deps.afterRestore?.(repo);
    }
  }
}
