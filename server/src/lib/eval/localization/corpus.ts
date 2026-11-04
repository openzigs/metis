/**
 * #1753 — the held-out localization corpora: analyst-worded requirements with
 * known ground-truth FILES, plus the code-graph symbol rows the arms search.
 *
 * Every localization number METIS had before this was in-sample: the six
 * Miniflux run-7 issues the `change-seeds.ts` constants were tuned on. These
 * corpora are the yardstick every arm of epic #1751 is compared on, so their
 * shape is checked here, before anything is measured:
 *
 *   - every ground-truth file is a file of the corpus's code graph. A file the
 *     graph does not hold (a template, a translation, a file the change
 *     created) cannot be found by any arm; it is recorded under the item's
 *     `excludedFiles` with the reason, never silently scored as a miss;
 *   - a held-out requirement reads as an analyst wrote it: no file path, no
 *     code identifier, no backticks ({@link codeShapedTokens}).
 *
 * The loader is pure over the committed files (no network, no database).
 */
import { promises as fs } from "node:fs";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDocumentationFilePath, isTestFilePath } from "../../analysis/traceability-matrix.js";

/** The three registered corpora (`eval-data/corpus/<name>`). */
export const LOCALIZATION_CORPORA = [
  "localization-01-miniflux-heldout",
  "localization-02-fixture-portfolio",
  "localization-00-miniflux-run7-insample",
] as const;

export type LocalizationCorpusName = (typeof LOCALIZATION_CORPORA)[number];

/** `implemented` / `partial` / `gap`: the portfolio verdict a fixture item expects. */
export const GAP_VERDICTS = ["implemented", "partial", "gap"] as const;
export type GapVerdict = (typeof GAP_VERDICTS)[number];

/** A repository a corpus was ingested from, pinned to one commit. */
export interface LocalizationRepo {
  /** Short name; the prefix of every file key (`<name>:<path>`). */
  name: string;
  url: string;
  /** The tag or branch the snapshot was taken from. */
  ref: string;
  /** The commit the symbols were ingested at. */
  sha: string;
}

/** Where an item's text and ground truth came from. */
export type LocalizationItemSource =
  | {
      kind: "upstream-pr";
      pr: number;
      mergeSha: string;
      mergedAt: string;
      closingIssues: number[];
      /** The PR's own title and description, as merged. */
      original: { title: string; body: string };
    }
  | { kind: "authored" }
  | {
      kind: "walkthrough-reference";
      issue: number;
      /** Where the reference change set is written down. */
      reference: string;
      original: { title: string; body: string };
    };

/** A ground-truth file the scorer does not count, and why. */
export interface ExcludedFile {
  file: string;
  reason: "test" | "documentation" | "not-in-code-graph" | "added-by-change";
}

/** One requirement and the files it should localize to. */
export interface LocalizationItem {
  id: string;
  /** What the arms see: an analyst-worded title and text. */
  title: string;
  text: string;
  /** Scored ground truth, `<repo>:<path>`, every one a file of the code graph. */
  expectedFiles: string[];
  /** The ground truth's repositories. */
  expectedRepos: string[];
  /** The portfolio gap verdict (fixture set only). */
  expectedVerdict?: GapVerdict;
  excludedFiles?: ExcludedFile[];
  source: LocalizationItemSource;
}

/** Who wrote the requirement text, and under which rule. */
export interface AnnotationRecord {
  rewrittenBy: string;
  rewrittenAt: string;
  /** True only when the writer had not seen the diffs (or the file lists) when writing. */
  sawDiffsBeforeRewriting: boolean;
  procedure: string;
  reviewedBy: string | null;
}

export interface LocalizationCorpusManifest {
  id: LocalizationCorpusName;
  description: string;
  /** `held-out` sets may claim a gain; an `in-sample` set never may. */
  purpose: "held-out" | "in-sample";
  license: string;
  repos: LocalizationRepo[];
  /** Path to the gzipped symbol rows, relative to the corpus directory. */
  symbols: string;
  annotation: AnnotationRecord;
  /**
   * Product names that look like identifiers ("YouTube") and are business
   * language here. Each is an exception to {@link codeShapedTokens}, written
   * down rather than silently tolerated.
   */
  allowedTerms?: string[];
  items: LocalizationItem[];
}

/** One ingested code symbol, as `CodeSymbol` (+ its embedding text) stores it. */
export interface LocalizationSymbolRow {
  id: string;
  repo: string;
  name: string;
  qualifiedName: string;
  kind: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docComment?: string;
  package?: string;
  /** `CodeSymbolEmbedding.text`; absent for a symbol production never embeds (a table). */
  embeddingText?: string;
  /** #1135 — the symbol has a lineage `writes` / `persists-to` edge. */
  writesData?: true;
}

export interface LocalizationSymbolsFile {
  note: string;
  repos: LocalizationRepo[];
  rows: LocalizationSymbolRow[];
}

/** A corpus, loaded and checked. */
export interface LocalizationCorpus {
  name: LocalizationCorpusName;
  dir: string;
  manifest: LocalizationCorpusManifest;
  symbols: LocalizationSymbolRow[];
  /** Every `<repo>:<path>` the code graph holds a symbol in. */
  graphFiles: ReadonlySet<string>;
}

/** The file key every metric compares: `<repo>:<path>`, path normalized. */
export function fileKey(repo: string, filePath: string): string {
  return `${repo}:${normalizeFilePath(filePath)}`;
}

/** Forward slashes, no leading `./` or `/`. Case is kept: paths are case-sensitive. */
export function normalizeFilePath(filePath: string): string {
  return filePath
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/|\/)+/, "");
}

/** The repository half of a {@link fileKey}. */
export function repoOfFileKey(key: string): string {
  const i = key.indexOf(":");
  return i < 0 ? "" : key.slice(0, i);
}

const CODE_SHAPES: Array<{ label: string; re: RegExp }> = [
  { label: "backtick", re: /`[^`]*`?/g },
  {
    label: "file name",
    re: /\b[\w-]+\.(?:go|ts|tsx|js|mjs|py|java|kt|rb|sql|html|css|json|ya?ml)\b/g,
  },
  { label: "path", re: /\b[\w.-]+\/[\w./-]+/g },
  { label: "call", re: /\b\w+\(\)/g },
  { label: "camelCase", re: /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g },
  { label: "PascalCase", re: /\b[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*\b/g },
  { label: "snake_case", re: /\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/g },
];

/**
 * Tokens in `text` that look like code rather than business language: a file
 * name, a path, a call, a camelCase / PascalCase / snake_case identifier, or
 * anything in backticks. A product name ("Karakeep", "Google Reader") is
 * business language and passes; an analyst does not write `FirstCategory`.
 */
export function codeShapedTokens(text: string, allowedTerms: readonly string[] = []): string[] {
  const allowed = new Set(allowedTerms);
  const found = new Set<string>();
  for (const { label, re } of CODE_SHAPES) {
    for (const m of text.matchAll(re)) if (!allowed.has(m[0])) found.add(`${label}: ${m[0]}`);
  }
  return [...found].sort();
}

/**
 * Check a manifest against its symbol rows. Returns every problem found (empty
 * when the corpus is sound) so one run lists them all.
 */
export function validateCorpus(
  manifest: LocalizationCorpusManifest,
  graphFiles: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  const repoNames = new Set(manifest.repos.map((r) => r.name));
  const ids = new Set<string>();
  if (manifest.items.length === 0) problems.push("corpus has no items");
  for (const item of manifest.items) {
    const where = `item ${item.id}`;
    if (ids.has(item.id)) problems.push(`${where}: duplicate id`);
    ids.add(item.id);
    if (!item.title.trim() || !item.text.trim()) problems.push(`${where}: empty title or text`);
    if (item.expectedFiles.length === 0) problems.push(`${where}: no ground-truth file`);
    for (const f of item.expectedFiles) {
      if (!repoNames.has(repoOfFileKey(f))) problems.push(`${where}: ${f} names an unknown repo`);
      else if (!graphFiles.has(f)) {
        problems.push(`${where}: ${f} is not a file of the code graph (list it in excludedFiles)`);
      }
    }
    const repos = [...new Set(item.expectedFiles.map(repoOfFileKey))].sort();
    if (repos.join(",") !== [...item.expectedRepos].sort().join(",")) {
      problems.push(
        `${where}: expectedRepos ${item.expectedRepos.join(",")} ≠ the files' ${repos}`,
      );
    }
    if (item.expectedVerdict !== undefined && !GAP_VERDICTS.includes(item.expectedVerdict)) {
      problems.push(`${where}: unknown verdict ${String(item.expectedVerdict)}`);
    }
    if (manifest.purpose === "held-out") {
      const leaks = codeShapedTokens(`${item.title}\n${item.text}`, manifest.allowedTerms);
      if (leaks.length > 0) problems.push(`${where}: code-shaped wording (${leaks.join("; ")})`);
    }
  }
  return problems;
}

/** Absolute path of the `eval-data/corpus` root. */
export function localizationCorpusRoot(): string {
  // server/src/lib/eval/localization → the repository root is five levels up.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../../../eval-data/corpus");
}

/** Resolve a registered corpus name; an unknown name throws with the known ones. */
export function resolveLocalizationCorpusDir(name: string): string {
  if (!(LOCALIZATION_CORPORA as readonly string[]).includes(name)) {
    throw new Error(
      `unknown localization corpus: ${JSON.stringify(name)}. Known: ${LOCALIZATION_CORPORA.join(", ")}.`,
    );
  }
  return path.join(localizationCorpusRoot(), name);
}

/** Decode a gzipped {@link LocalizationSymbolsFile}. */
export function decodeSymbolsFile(bytes: Buffer): LocalizationSymbolsFile {
  return JSON.parse(gunzipSync(bytes).toString("utf8")) as LocalizationSymbolsFile;
}

/** A changed file as the GitHub pull-request files API lists it. */
export interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

/**
 * Split a merged change's files into scored ground truth and excluded files,
 * with the rules seeding itself uses (`change-seeds.ts`): a test file and a
 * documentation file are never edit candidates. Of the rest, a file the code
 * graph holds is ground truth; one it does not is excluded as
 * `added-by-change` (the snapshot predates it) or `not-in-code-graph` (a
 * template, a translation, a manifest). A renamed file is looked up under its
 * old path, which is the file the snapshot holds.
 */
export function classifyChangedFiles(
  repo: string,
  files: readonly ChangedFile[],
  graphFiles: ReadonlySet<string>,
): { expectedFiles: string[]; excludedFiles: ExcludedFile[] } {
  const expected = new Set<string>();
  const excludedFiles: ExcludedFile[] = [];
  for (const f of files) {
    const filePath =
      f.status === "renamed" && f.previous_filename ? f.previous_filename : f.filename;
    const key = fileKey(repo, filePath);
    if (isTestFilePath(filePath)) excludedFiles.push({ file: key, reason: "test" });
    else if (isDocumentationFilePath(filePath)) {
      excludedFiles.push({ file: key, reason: "documentation" });
    } else if (graphFiles.has(key)) expected.add(key);
    else if (f.status === "added") excludedFiles.push({ file: key, reason: "added-by-change" });
    else excludedFiles.push({ file: key, reason: "not-in-code-graph" });
  }
  return { expectedFiles: [...expected].sort(), excludedFiles };
}

/** The `<repo>:<path>` of every file the symbol rows hold. */
export function graphFilesOf(rows: readonly LocalizationSymbolRow[]): Set<string> {
  return new Set(rows.map((r) => fileKey(r.repo, r.filePath)));
}

/**
 * Load and check a corpus. Throws, listing every problem, when the manifest
 * does not match its symbol rows: a corpus that does not hold together must
 * fail before it produces a number.
 */
export async function loadLocalizationCorpus(
  name: LocalizationCorpusName,
  dir: string = resolveLocalizationCorpusDir(name),
): Promise<LocalizationCorpus> {
  const manifest = JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as LocalizationCorpusManifest;
  if (manifest.id !== name) {
    throw new Error(`corpus ${name}: manifest id is ${JSON.stringify(manifest.id)}`);
  }
  const symbolsFile = decodeSymbolsFile(await fs.readFile(path.resolve(dir, manifest.symbols)));
  const wanted = new Set(manifest.repos.map((r) => `${r.name}@${r.sha}`));
  const have = new Set(symbolsFile.repos.map((r) => `${r.name}@${r.sha}`));
  const missing = [...wanted].filter((r) => !have.has(r));
  if (missing.length > 0) {
    throw new Error(`corpus ${name}: the symbol rows hold no snapshot of ${missing.join(", ")}`);
  }
  const repoNames = new Set(manifest.repos.map((r) => r.name));
  const symbols = symbolsFile.rows.filter((r) => repoNames.has(r.repo));
  const graphFiles = graphFilesOf(symbols);
  const problems = validateCorpus(manifest, graphFiles);
  if (problems.length > 0) {
    throw new Error(`corpus ${name} is not sound:\n  - ${problems.join("\n  - ")}`);
  }
  return { name, dir, manifest, symbols, graphFiles };
}
