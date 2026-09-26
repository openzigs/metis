/**
 * Path scope for holistic document generation.
 *
 * A generate request may carry `pathPrefixes` — repository-relative path
 * prefixes such as `["packages/fit/"]`. When present, only modules and files
 * under those prefixes enter Phase 1, every Phase-2 section reads only their
 * facts, repository-source grounding is restricted to the same paths, and the
 * document says so (title, banner, provenance) so a scoped document is never
 * mistaken for a full one. The use case is a fast local test run: a full
 * project on a local model takes ~30 h, one business-logic sub-tree ~1 h.
 *
 * SECURITY (OWASP A01/A03 — path traversal): a prefix is a STRING PATTERN,
 * never a path. It is matched against the repository-relative `filePath`
 * values already stored on code symbols, and is never joined to a directory
 * or used to open a file. Validation is still strict — `..` segments,
 * absolute and drive-letter paths, NUL/control characters, over-long values
 * and over-long lists are rejected — so a stored scope cannot become a
 * traversal primitive if a later caller ever does treat it as a path.
 */
import { z } from "zod";

/** Most prefixes one request may carry. */
export const MAX_PATH_PREFIXES = 20;
/** Longest accepted prefix, in characters (before normalisation). */
export const MAX_PATH_PREFIX_LENGTH = 256;

/** Stable machine code for "the scope matched no documentable code". */
export const PATH_SCOPE_EMPTY_CODE = "PATH_SCOPE_EMPTY";

/** Thrown when a path scope leaves nothing to document. */
export class PathScopeEmptyError extends Error {
  readonly code = PATH_SCOPE_EMPTY_CODE;
  constructor(readonly prefixes: readonly string[]) {
    super(
      `The path scope matched no documentable code: ${prefixes.join(", ")}. ` +
        "Prefixes are repository-relative (for example packages/fit/).",
    );
    this.name = "PathScopeEmptyError";
  }
}

/**
 * Normalise one prefix to the canonical `a/b` form (forward slashes, no
 * leading `./`, no duplicate or trailing slash). Returns an error string when
 * the value is not an acceptable repository-relative prefix.
 */
export function normalizePathPrefix(
  raw: string,
): { ok: true; value: string } | { ok: false; error: string } {
  if (raw.length > MAX_PATH_PREFIX_LENGTH) {
    return { ok: false, error: `must be at most ${MAX_PATH_PREFIX_LENGTH} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, error: "must not contain NUL or control characters" };
  }
  const slashed = raw.trim().replace(/\\/g, "/");
  if (slashed.startsWith("/") || /^[A-Za-z]:/.test(slashed) || slashed.startsWith("~")) {
    return { ok: false, error: "must be repository-relative, not absolute" };
  }
  const segments = slashed.split("/").filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) {
    return { ok: false, error: "must not contain '..' segments" };
  }
  if (segments.length === 0) {
    return { ok: false, error: "must name a directory or file inside the repository" };
  }
  return { ok: true, value: segments.join("/") };
}

/**
 * Zod schema for the request field: 1..{@link MAX_PATH_PREFIXES} prefixes,
 * each validated and normalised, de-duplicated, order-preserving.
 */
export const pathPrefixesSchema = z
  .array(z.string().max(MAX_PATH_PREFIX_LENGTH))
  .min(1, "pathPrefixes must name at least one prefix")
  .max(MAX_PATH_PREFIXES, `pathPrefixes accepts at most ${MAX_PATH_PREFIXES} prefixes`)
  .transform((values, ctx) => {
    const out: string[] = [];
    values.forEach((raw, i) => {
      const n = normalizePathPrefix(raw);
      if (!n.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pathPrefixes[${i}] ${n.error}`,
          path: [i],
        });
        return;
      }
      if (!out.includes(n.value)) out.push(n.value);
    });
    return out;
  });

/**
 * Read a stored scope back (the value in `scopeFilter.pathPrefixes`). Absent
 * → `null` (unscoped). Present but invalid → throws: a corrupted scope must
 * fail loudly, never silently widen to the full project.
 */
export function readStoredPathScope(filter: Record<string, unknown>): string[] | null {
  if (filter.pathPrefixes === undefined) return null;
  const parsed = pathPrefixesSchema.safeParse(filter.pathPrefixes);
  if (!parsed.success) throw new Error("Stored path scope is invalid");
  return parsed.data;
}

/** Normalise a stored repository-relative file path for matching. */
function normalizeStoredPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

/**
 * Whether a repository-relative path is inside the scope. Matching is
 * segment-aware: `packages/fit` matches `packages/fit` and `packages/fit/x.ts`,
 * never `packages/fitness/x.ts`.
 */
export function isInPathScope(filePath: string, prefixes: readonly string[]): boolean {
  const p = normalizeStoredPath(filePath);
  return prefixes.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

/**
 * Prisma `OR` fragment selecting CANDIDATE code symbols for the scope. The
 * prefixes are bound as query parameters by Prisma, never interpolated into
 * SQL — but Prisma 7 compiles `startsWith` to `LIKE (? || '%')` without
 * escaping `%` or `_` (and SQLite's LIKE is ASCII case-insensitive), so this
 * over-matches: `pack_ges/` selects `packages/…`. Use it only as a coarse
 * filter and confirm each row with {@link isInPathScope}, as
 * {@link probePathScope} does. Escaping is not an option: SQLite LIKE has no
 * default escape character, so a backslash would be matched literally there.
 */
export function pathScopeWhere(
  prefixes: readonly string[],
): Array<{ filePath: string } | { filePath: { startsWith: string } }> {
  return prefixes.flatMap((p) => [{ filePath: p }, { filePath: { startsWith: `${p}/` } }]);
}

/** Candidate rows fetched per page by {@link probePathScope}. */
export const PATH_SCOPE_PROBE_PAGE_SIZE = 500;
/** Pages {@link probePathScope} reads before giving up with `"unknown"`. */
export const PATH_SCOPE_PROBE_MAX_PAGES = 20;

/** Outcome of {@link probePathScope}. */
export type PathScopeProbe = "match" | "none" | "unknown";

/**
 * Whether any stored file path is inside the scope, EXACTLY. `fetchPage`
 * returns candidate rows (the {@link pathScopeWhere} filter, ordered by id,
 * after `afterId`); each is confirmed with {@link isInPathScope}, so a LIKE
 * wildcard or case false positive never counts. In the normal case the first
 * candidate confirms. `"unknown"` when the page cap is reached without a
 * confirmed match: the caller must not report the scope as empty then — the
 * run-time {@link restrictToPathScope} check is authoritative.
 */
export async function probePathScope(
  prefixes: readonly string[],
  fetchPage: (page: {
    afterId: string | undefined;
    take: number;
  }) => Promise<ReadonlyArray<{ id: string; filePath: string }>>,
): Promise<PathScopeProbe> {
  let afterId: string | undefined;
  for (let page = 0; page < PATH_SCOPE_PROBE_MAX_PAGES; page += 1) {
    const rows = await fetchPage({ afterId, take: PATH_SCOPE_PROBE_PAGE_SIZE });
    if (rows.some((r) => isInPathScope(r.filePath, prefixes))) return "match";
    if (rows.length < PATH_SCOPE_PROBE_PAGE_SIZE) return "none";
    afterId = rows[rows.length - 1].id;
  }
  return "unknown";
}

interface ScopableModule {
  dir: string;
  syms: Array<{ filePath: string }>;
}

/**
 * Restrict the synthesizer's inputs to the scope, IN PLACE (the synthesizer
 * holds these arrays by reference). A module keeps only its in-scope symbols
 * and is dropped when none remain; a symbol-less (SQL-only) module is kept
 * when its directory is in scope. The project meta counts are rewritten to
 * the scoped files and symbols, so the document header does not claim the
 * whole project. Throws {@link PathScopeEmptyError} when nothing remains.
 */
export function restrictToPathScope<M extends ScopableModule>(
  prefixes: readonly string[],
  inputs: {
    modules: M[];
    symbols: Array<{ filePath: string }>;
    meta: { totalFiles: number; totalSymbols: number };
  },
): { modules: number; files: number; symbols: number } {
  const kept: M[] = [];
  for (const m of inputs.modules) {
    if (m.syms.length === 0) {
      if (isInPathScope(m.dir, prefixes)) kept.push(m);
      continue;
    }
    const syms = m.syms.filter((s) => isInPathScope(s.filePath, prefixes));
    if (syms.length > 0) kept.push({ ...m, syms });
  }
  if (kept.length === 0) throw new PathScopeEmptyError(prefixes);
  inputs.modules.splice(0, inputs.modules.length, ...kept);
  const symbols = inputs.symbols.filter((s) => isInPathScope(s.filePath, prefixes));
  inputs.symbols.splice(0, inputs.symbols.length, ...symbols);
  const files = new Set(symbols.map((s) => s.filePath)).size;
  inputs.meta.totalFiles = files;
  inputs.meta.totalSymbols = symbols.length;
  return { modules: kept.length, files, symbols: symbols.length };
}

/** Human label of a scope, e.g. `packages/fit/, packages/rules/`. */
export function pathScopeLabel(prefixes: readonly string[]): string {
  return prefixes.map((p) => `${p}/`).join(", ");
}

/** Document titles are capped at 200 characters by the generate route. */
const TITLE_MAX = 200;

/**
 * The stored title of a scoped document: the requested title plus a visible
 * scope suffix, within the 200-character title limit. The suffix always
 * survives; the requested title is what gets shortened.
 */
export function scopedDocumentTitle(title: string, prefixes: readonly string[]): string {
  const full = ` [scope: ${pathScopeLabel(prefixes)}]`;
  const suffix =
    full.length <= 80
      ? full
      : ` [scope: ${prefixes.length} path${prefixes.length === 1 ? "" : "s"}]`;
  const room = TITLE_MAX - suffix.length;
  const base = title.length > room ? `${title.slice(0, room - 1).trimEnd()}…` : title;
  return `${base}${suffix}`;
}

/**
 * A CommonMark code span that holds `text` verbatim, whatever backticks it
 * contains: the delimiter is one backtick longer than the longest run inside,
 * and the content is space-padded when it starts or ends with a backtick.
 * Prefixes are user input written into markdown (OWASP A03); with a plain
 * single-backtick span, a backtick in a prefix closed the span and the rest
 * rendered as markdown — an external image or link in every viewer's browser.
 */
function markdownCodeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Insert the scope banner directly under the document's H1 (or at the top
 * when there is none), so the rendered document states it is partial.
 */
export function withPathScopeBanner(markdown: string, prefixes: readonly string[]): string {
  const banner =
    `> **Scoped document — not a full-project document.** Generated only from ` +
    `${prefixes.map((p) => markdownCodeSpan(`${p}/`)).join(", ")}; modules outside these paths were not read.\n`;
  if (markdown.startsWith("# ")) {
    const eol = markdown.indexOf("\n");
    if (eol === -1) return `${markdown}\n\n${banner}`;
    return `${markdown.slice(0, eol + 1)}\n${banner}${markdown.slice(eol + 1)}`;
  }
  return `${banner}\n${markdown}`;
}
