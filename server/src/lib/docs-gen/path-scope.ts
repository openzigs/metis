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
 * Prisma `OR` fragment selecting code symbols inside the scope, with the same
 * segment-aware semantics as {@link isInPathScope}. The prefixes are bound as
 * query parameters by Prisma, never interpolated into SQL.
 */
export function pathScopeWhere(
  prefixes: readonly string[],
): Array<{ filePath: string } | { filePath: { startsWith: string } }> {
  return prefixes.flatMap((p) => [{ filePath: p }, { filePath: { startsWith: `${p}/` } }]);
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
 * Insert the scope banner directly under the document's H1 (or at the top
 * when there is none), so the rendered document states it is partial.
 */
export function withPathScopeBanner(markdown: string, prefixes: readonly string[]): string {
  const banner =
    `> **Scoped document — not a full-project document.** Generated only from ` +
    `${prefixes.map((p) => `\`${p}/\``).join(", ")}; modules outside these paths were not read.\n`;
  if (markdown.startsWith("# ")) {
    const eol = markdown.indexOf("\n");
    if (eol === -1) return `${markdown}\n\n${banner}`;
    return `${markdown.slice(0, eol + 1)}\n${banner}${markdown.slice(eol + 1)}`;
  }
  return `${banner}\n${markdown}`;
}
