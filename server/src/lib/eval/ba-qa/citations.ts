/**
 * #2237 — the sources a chat answer cites, read from its prose in code.
 *
 * A chat answer names its sources as paths (`internal/model/feed.go:123-150`,
 * `` `miniflux.py` ``, `connector:repo:<id>:internal/api/middleware.go`), often
 * with a line or a range after it. Each path-shaped token is resolved against
 * the files of the products in the question's scope (their repository files,
 * plus the documents uploaded to them):
 *
 *   - an exact path, or one prefixed with `<product>/`, names that file;
 *   - a partial path or bare file name names the file it is the suffix of, when
 *     exactly ONE file in the product ends with it. Several is ambiguous: it is
 *     counted, never guessed, as `eval/chat-cache/cited-files.ts` does;
 *   - the same path in several products (a README, a document uploaded to
 *     both) is one citation naming each of them.
 *
 * A token that names no file (a URL host, a Go import path) is not a citation.
 */

/** What a token is resolved against: one product's files and uploaded documents. */
export interface CitableProduct {
  name: string;
  /** Repository-relative paths. */
  files: readonly string[];
  /** Uploaded filename → the path a source names it by (`miniflux.1.txt` → `miniflux.1`). */
  documents: ReadonlyMap<string, string>;
}

export interface Citation {
  /** The path, as the fixture's sources name it. */
  path: string;
  /** Every product in scope that holds `path`; one, unless the file is shared. */
  products: string[];
  /** The cited line range, when the answer gave one. */
  lines: [number, number] | null;
}

export interface ExtractedCitations {
  citations: Citation[];
  /** Tokens that matched more than one file within a product. */
  ambiguous: string[];
}

/**
 * A path-shaped token, then an optional line reference: `:12`, `:12-40`,
 * `#L12`, `#L12-L40`, or `lines 12-40` / `line 12` after a space or bracket.
 *
 * #2290 — the lookbehind starts a match only where a path can start, so a long
 * run of path characters is scanned once, not once per position: linear, where
 * the bare pattern is quadratic (48 s on 200,000 characters in #2242).
 */
const CITATION =
  /(?<![A-Za-z0-9_.\-/])([A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8})(?![A-Za-z0-9])(?:(?::|#L)(\d{1,6})(?:\s*[-–]\s*L?(\d{1,6}))?|[`'")\]]?[\s(,]*\blines?\s+(\d{1,6})(?:\s*[-–]\s*(\d{1,6}))?)?/g;

/** The paths `token` names in one product: exact first, else a unique suffix. */
function resolveIn(product: CitableProduct, token: string): string[] {
  const names = new Map<string, string>();
  for (const f of product.files) names.set(f, f);
  for (const [upload, logical] of product.documents) names.set(upload, logical);
  let t = token;
  if (t.startsWith(`${product.name}/`) && !names.has(t)) t = t.slice(product.name.length + 1);
  const exact = names.get(t);
  if (exact) return [exact];
  const hits = new Set<string>();
  for (const [name, logical] of names) {
    if (name.endsWith(`/${t}`)) hits.add(logical);
  }
  return [...hits];
}

function lineRange(start?: string, end?: string): [number, number] | null {
  if (!start) return null;
  const a = Number(start);
  const b = end ? Number(end) : a;
  if (a < 1 || b < 1) return null;
  return a <= b ? [a, b] : [b, a];
}

export function extractCitations(
  answer: string,
  products: readonly CitableProduct[],
): ExtractedCitations {
  const byKey = new Map<string, Citation>();
  const ambiguous = new Set<string>();
  for (const m of answer.matchAll(CITATION)) {
    const token = m[1].replace(/^\.?\/+/, "");
    const lines = lineRange(m[2] ?? m[4], m[3] ?? m[5]);
    const found = new Map<string, string[]>();
    let isAmbiguous = false;
    for (const product of products) {
      const paths = resolveIn(product, token);
      if (paths.length > 1) isAmbiguous = true;
      if (paths.length === 1) {
        found.set(paths[0], [...(found.get(paths[0]) ?? []), product.name]);
      }
    }
    if (found.size === 0) {
      if (isAmbiguous) ambiguous.add(token);
      continue;
    }
    if (found.size > 1) {
      // One token, different files in different products: not a citation of either.
      ambiguous.add(token);
      continue;
    }
    const [[p, names]] = [...found];
    const key = `${names.join(",")}:${p}:${lines ? lines.join("-") : ""}`;
    if (!byKey.has(key)) byKey.set(key, { path: p, products: names, lines });
  }
  const citations = [...byKey.values()].sort(
    (a, b) =>
      a.products.join().localeCompare(b.products.join()) ||
      a.path.localeCompare(b.path) ||
      (a.lines?.[0] ?? 0) - (b.lines?.[0] ?? 0),
  );
  return { citations, ambiguous: [...ambiguous].sort() };
}

/** Whether a citation names this `<product>:<path>` file. */
export function citesFile(c: Citation, product: string, file: string): boolean {
  return c.path === file && c.products.includes(product);
}
