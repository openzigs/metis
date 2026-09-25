/**
 * Grouping a project's code symbols into the documentable modules Phase 1
 * reads. Pure (no I/O) so the selection is unit-testable and measurable offline.
 *
 * The directory rules are the long-standing ones (a directory is a module when
 * it has ≥1 class/interface or ≥4 methods/functions and ≥3 symbols; a directory
 * of more than 200 symbols is split per file, and a file qualifies when it has a
 * class/interface and ≥3 symbols; SAS relaxations apply to both). What changed
 * is that nothing is dropped any more:
 *
 *   - Every file the rules leave out — a class-less file inside a split
 *     directory, a small directory, a file whose only symbol is its `module`
 *     row (top-level constants, zod schemas, config objects) — is gathered into
 *     a per-directory module, or joins the directory's module when it has one.
 *     On onyourleft the rules alone left 325 functions in 68 class-less files
 *     and 115 module-level-only files (including the store's `schema.ts`) out
 *     of every module.
 *   - There is no module-count cap (the old top-150-by-size cut): Phase-2
 *     batching reads every module, so a cap only decides which code is never
 *     read.
 */
import type { RepositoryIdentity } from "./repository-identity.js";

/** One code symbol as the grouping sees it. */
export interface GroupableSymbol {
  id: string;
  qualifiedName: string;
  kind: string;
  language?: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** A documentable module: a directory (or one file of a split directory) and its symbols. */
export interface SymbolModule<S extends GroupableSymbol = GroupableSymbol> {
  repository?: RepositoryIdentity;
  dir: string;
  syms: S[];
}

/**
 * True for a SAS business-logic symbol: SAS programs have no classes, so their
 * `%macro` blocks, DATA steps and PROC steps (all `function` symbols from the
 * SAS parser) are what make a SAS directory documentable.
 */
export function isSasBusinessSymbol(sym: { kind: string; language?: string | null }): boolean {
  return sym.language === "sas" && sym.kind === "function";
}

/** Directory segments whose code is never documented. */
const EXCLUDED_DIR = /\/(test|tests|generated|node_modules|build|target|\.next)\//;

/** Directories with more symbols than this are split into per-file modules. */
export const SPLIT_THRESHOLD = 200;

const isClassLike = (s: GroupableSymbol) => s.kind === "class" || s.kind === "interface";
const isCallable = (s: GroupableSymbol) => s.kind === "method" || s.kind === "function";

/**
 * Group symbols (already filtered of junk paths) into modules.
 *
 * @param keyOf - identity of a (repository, path) pair, so two repositories'
 *   same-named directories never merge.
 */
export function groupSymbolsIntoModules<S extends GroupableSymbol>(
  symbols: readonly S[],
  repositoryOf: (s: S) => RepositoryIdentity | undefined,
  keyOf: (repository: RepositoryIdentity | undefined, path: string) => string,
): SymbolModule<S>[] {
  const dirOf = (fp: string) => fp.split("/").slice(0, -1).join("/");
  // Per directory: the symbols the rules read, and every file's symbols (for leftovers).
  const byDir = new Map<string, { dir: string; repository?: RepositoryIdentity; syms: S[] }>();
  const filesByDir = new Map<string, Map<string, S[]>>();
  for (const sym of symbols) {
    const dir = dirOf(sym.filePath);
    if (EXCLUDED_DIR.test(dir)) continue;
    const repository = repositoryOf(sym);
    const key = keyOf(repository, dir);
    if (!filesByDir.has(key)) filesByDir.set(key, new Map());
    const files = filesByDir.get(key)!;
    if (!files.has(sym.filePath)) files.set(sym.filePath, []);
    files.get(sym.filePath)!.push(sym);
    if (sym.kind === "module" || sym.kind === "type") continue;
    if (!byDir.has(key)) byDir.set(key, { dir, repository, syms: [] });
    byDir.get(key)!.syms.push(sym);
  }

  const modules: SymbolModule<S>[] = [];
  const moduleOfDir = new Map<string, SymbolModule<S>>();
  const covered = new Set<string>();
  const cover = (repository: RepositoryIdentity | undefined, syms: readonly S[]) => {
    for (const s of syms) covered.add(keyOf(repository, s.filePath));
  };
  for (const [key, { dir, repository, syms }] of byDir) {
    if (syms.length <= SPLIT_THRESHOLD) {
      const standard =
        (syms.filter(isClassLike).length >= 1 || syms.filter(isCallable).length >= 4) &&
        syms.length >= 3;
      if (standard || syms.filter(isSasBusinessSymbol).length >= 3) {
        const m = { dir, syms: [...syms], repository };
        modules.push(m);
        moduleOfDir.set(key, m);
        cover(repository, syms);
      }
      continue;
    }
    const byFile = new Map<string, S[]>();
    for (const s of syms) {
      if (!byFile.has(s.filePath)) byFile.set(s.filePath, []);
      byFile.get(s.filePath)!.push(s);
    }
    for (const [filePath, fileSyms] of byFile) {
      const standard = fileSyms.filter(isClassLike).length >= 1 && fileSyms.length >= 3;
      if (standard || fileSyms.filter(isSasBusinessSymbol).length >= 3) {
        // The file path without extension names a per-file module.
        modules.push({ dir: filePath.replace(/\.[^.]+$/, ""), syms: fileSyms, repository });
        cover(repository, fileSyms);
      }
    }
  }

  // Leftovers: every file no module covers joins its directory's module, or a
  // per-directory module made for them. A file contributes its code symbols,
  // or — when it has none — the one symbol that proves it exists (its `module`
  // row), so Phase 1 reads it in full as module-level code.
  for (const [key, files] of filesByDir) {
    for (const [filePath, fileSyms] of files) {
      const repository = repositoryOf(fileSyms[0]);
      if (covered.has(keyOf(repository, filePath))) continue;
      const code = fileSyms.filter((s) => s.kind !== "module" && s.kind !== "type");
      const carried =
        code.length > 0 ? code : [fileSyms.find((s) => s.kind === "module") ?? fileSyms[0]];
      let m = moduleOfDir.get(key);
      if (!m) {
        m = { dir: dirOf(filePath), syms: [], repository };
        modules.push(m);
        moduleOfDir.set(key, m);
      }
      m.syms.push(...carried);
      covered.add(keyOf(repository, filePath));
    }
  }

  return modules.sort((a, b) => b.syms.length - a.syms.length);
}
