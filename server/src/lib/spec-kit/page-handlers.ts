/**
 * #1135 — the HTTP handlers that serve the page or action a spec names.
 *
 * A bug report about a page ("after 'Mark this page as read' the feed shows 0
 * entries") is written in the words of the page, and similarity retrieval
 * returns the code that shares those words: the JavaScript action, the storage
 * status writers. The handler that BUILDS the page (`showFeedEntriesPage` in
 * `internal/ui/feed_entries.go`) shares its words only through its NAME, and
 * nothing in the code graph ties a script's page reload to it. In #706 run 8 the
 * plan for Miniflux #4386 was never given that file, and put the fix in
 * `app.js`.
 *
 * So, when the spec names a page or a UI action, the handlers whose names
 * match the spec's words are listed in the plan's context. A handler is a
 * function whose declaration takes an HTTP request and response (Go
 * `http.ResponseWriter`, an Express `(req, res)`, …): read from the stored
 * signature, so no source file is opened. The listed handlers also seed the
 * structural-twin step, which is how `showCategoryEntriesPage` (the same
 * pattern, another page) and `showUnreadPage` (the page that already gets it
 * right) are reached.
 *
 * Pure apart from the types; the read is the localisation source's.
 */

/** Words that say the spec is about a page or something done on one. */
const UI_WORDS_RE =
  /\b(?:page|pages|screen|screens|view|views|button|buttons|click|clicks|clicked|shortcut|shortcuts|menu|tab|link|form|dialog|sidebar|toolbar|navigation|ui)\b/i;

/** True when `text` names a page or a UI action. One linear scan. */
export function namesPageOrUiAction(text: string): boolean {
  return UI_WORDS_RE.test(text);
}

/**
 * Substrings of a stored signature that mark an HTTP handler. Matched with
 * `contains`, so each must be specific enough not to match ordinary code.
 */
export const HTTP_HANDLER_SIGNATURE_MARKERS: readonly string[] = [
  "http.ResponseWriter", // Go net/http
  "*gin.Context", // Gin
  "echo.Context", // Echo
  "*fiber.Ctx", // Fiber
  "res: Response", // Express, typed
  "(req, res)", // Express, untyped
  "(req, res,", // Express, untyped with next
  "NextRequest", // Next.js route handler
  "HttpServletResponse", // Java servlet
];

export function isHttpHandlerSignature(signature: string | null | undefined): boolean {
  if (!signature) return false;
  return HTTP_HANDLER_SIGNATURE_MARKERS.some((m) => signature.includes(m));
}

/**
 * Name parts that say what a handler IS, not which page it serves: matching
 * one of them is no evidence. `page` is here too — nearly every page handler
 * has it — and is used only to prefer a page handler when the spec names one.
 */
const GENERIC_NAME_TOKENS: ReadonlySet<string> = new Set([
  "show",
  "page",
  "handler",
  "handle",
  "get",
  "set",
  "post",
  "put",
  "patch",
  "delete",
  "render",
  "view",
  "serve",
  "http",
  "api",
  "action",
  "all",
  "do",
  "on",
  "func",
  // Joining words: `markAllAsRead` matches "as" in any English spec.
  "as",
  "to",
  "by",
  "of",
  "for",
  "in",
  "and",
  "from",
  "with",
  "the",
]);

/** `entries` → `entry`, `feeds` → `feed`; leaves `status`, `class`, `is` alone. */
function stem(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith("s") && !/(?:ss|us|is)$/.test(word))
    return word.slice(0, -1);
  return word;
}

/** `showFeedEntriesPage` / `show_feed_entries_page` → `show feed entry page`. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t.length > 0)
    .map((t) => stem(t.toLowerCase()));
}

/** The longest spec text read: what the localisation reads too. */
export const MAX_SCANNED_HANDLER_SPEC_CHARS = 20_000;

/** Stemmed word → how often the spec uses it. */
export function specWordCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text
    .slice(0, MAX_SCANNED_HANDLER_SPEC_CHARS)
    .toLowerCase()
    .matchAll(/[a-z]+/g)) {
    const w = stem(m[0]);
    counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return counts;
}

export interface HandlerCandidate {
  id: string;
  /** The function's own name (`showFeedEntriesPage`). */
  name: string;
  filePath: string;
}

export interface RankedHandler<T extends HandlerCandidate = HandlerCandidate> {
  handler: T;
  /** Distinct name parts the spec uses. */
  matched: string[];
  /** `matched` over the name's specific parts. */
  precision: number;
}

/** A handler whose specific name parts the spec uses less than this share of is not listed. */
export const MIN_HANDLER_NAME_PRECISION = 0.5;

/**
 * The handlers whose names the spec's words match, best first: a page handler
 * first when the spec names a page (a bug seen on a page is fixed where the
 * page is built), then more matched name parts, then a larger share of the
 * name matched, then the spec's use of the matched words.
 */
export function rankHandlers<T extends HandlerCandidate>(
  candidates: readonly T[],
  specText: string,
): RankedHandler<T>[] {
  const words = specWordCounts(specText);
  const wantsPage = (words.get("page") ?? 0) > 0;
  const scored = candidates.flatMap((handler) => {
    const tokens = nameTokens(handler.name);
    const specific = [...new Set(tokens.filter((t) => !GENERIC_NAME_TOKENS.has(t)))];
    if (specific.length === 0) return [];
    const matched = specific.filter((t) => words.has(t));
    const precision = matched.length / specific.length;
    if (matched.length === 0 || precision < MIN_HANDLER_NAME_PRECISION) return [];
    const isPage = tokens.includes("page");
    const weight = matched.reduce((sum, t) => sum + Math.log1p(words.get(t) ?? 0), 0);
    return [{ handler, matched, precision, isPage, weight }];
  });
  scored.sort(
    (a, b) =>
      Number(wantsPage && b.isPage) - Number(wantsPage && a.isPage) ||
      b.matched.length - a.matched.length ||
      b.precision - a.precision ||
      b.weight - a.weight ||
      a.handler.name.localeCompare(b.handler.name) ||
      a.handler.filePath.localeCompare(b.handler.filePath),
  );
  return scored.map(({ handler, matched, precision }) => ({ handler, matched, precision }));
}
