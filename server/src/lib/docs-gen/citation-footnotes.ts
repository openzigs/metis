/**
 * #737 — render the grounding ids the model cites as working, readable,
 * document-scoped footnotes.
 *
 * Phase 2 is told to cite the `id` of each grounding source inline
 * (`[facts:…]`, `[rag:…]`, `[web:…]`). Those ids are internal: a repository
 * module id is a URL-encoded JSON tuple (#1354), so #1360 stripped every marker
 * at assembly. The reader then got no citations at all — or, where the model
 * wrapped markers in parentheses, empty `(,,,)` — and the model compensated by
 * writing its own per-section "source key" tables of raw ids whose handles
 * (`S1`, `[^storage]`) meant different modules in different sections.
 *
 * This runs at ASSEMBLY, after claim extraction and judging (so grounding is
 * scored on what the model wrote) and over the WHOLE document, so:
 *   - every marker becomes a GFM footnote reference, numbered once for the
 *     document — a module cited from two sections is one footnote, however its
 *     per-section rank-suffixed id differs (`facts:…:0` vs `facts:…:3`);
 *   - each definition names the source a reader can open: the module path, or
 *     `file:start-end` for a typed-symbol source;
 *   - a parenthesised run of markers collapses to the references alone;
 *   - an id that matches no admitted source is dropped, as before;
 *   - a bare id the model copied into its own prose or key table is replaced by
 *     the readable reference, so no URL-encoded key reaches the reader.
 *
 * Pure: no I/O. Fenced code is never touched.
 */
import type { GroundingSource } from "./grounding/grounding-context.js";

/** A bracketed marker; unterminated at end of line when the model was cut off. */
const MARKER = String.raw`\[\s*(?:facts|rag|web):[^\]\n]*(?:\]|$)`;

/** An optional leading space, an optional `(`, a run of markers, an optional `)`. */
const CLUSTER_RE = new RegExp(
  String.raw`( ?)(\(\s*)?(${MARKER}(?:[\s,;]*${MARKER})*)(\s*\))?`,
  "g",
);
const MARKER_RE = new RegExp(MARKER, "g");

/** A bare id, optionally in backticks, that the model wrote outside a marker. */
const BARE_ID_RE = /`?\b((?:facts|rag|web):[^\s\])|`,;]+)`?/g;

/** Footnote label prefix, distinct from any footnote the model wrote itself. */
const LABEL_PREFIX = "src-";

/** `[connector, graph, path]` from a `repo:<encoded JSON>` identity, else null. */
function decodeRepositoryPath(identity: string): string | null {
  if (!identity.startsWith("repo:")) return null;
  try {
    const tuple: unknown = JSON.parse(decodeURIComponent(identity.slice("repo:".length)));
    if (Array.isArray(tuple) && typeof tuple[2] === "string" && tuple[2]) return tuple[2];
  } catch {
    // Not a repository identity — the caller falls back to the label.
  }
  return null;
}

/** Path and line range of a `facts:symbol:<enc identity>:<symbol>:<start>-<end>` id. */
function decodeSymbolLocation(sourceId: string): string | null {
  if (!sourceId.startsWith("facts:symbol:")) return null;
  const parts = sourceId.slice("facts:symbol:".length).split(":");
  if (parts.length < 3) return null;
  const range = parts[parts.length - 1];
  if (!/^\d+-\d+$/.test(range)) return null;
  let identity: string;
  try {
    identity = decodeURIComponent(parts.slice(0, -2).join(":"));
  } catch {
    return null;
  }
  const path = decodeRepositoryPath(identity) ?? (identity.startsWith("repo:") ? null : identity);
  if (!path) return null;
  const [start, end] = range.split("-");
  return start === end ? `${path}:${start}` : `${path}:${range}`;
}

/** Module path of a `facts:repo:<enc>:<idx>` id, else null. */
function decodeModulePath(sourceId: string): string | null {
  const m = /^facts:(repo:[^:]+):\d+$/.exec(sourceId);
  return m ? decodeRepositoryPath(m[1]) : null;
}

const code = (s: string): string => `\`${s.replace(/`/g, "")}\``;

/** The reference a reader can follow for one admitted grounding source. */
export function readableSourceReference(source: GroundingSource): string {
  if (source.kind === "facts") {
    const location = decodeSymbolLocation(source.sourceId);
    if (location) return `${code(location)} — ${code(source.label)}`;
    return `${code(decodeModulePath(source.sourceId) ?? source.label)} (module facts)`;
  }
  if (source.kind === "rag") return `${code(source.label)} (retrieved excerpt)`;
  return `${code(source.label.replace(/^web:/, ""))} (web research)`;
}

/** The readable form of a bare id, from the admitted sources or the id itself. */
function readableBareId(id: string, byId: ReadonlyMap<string, GroundingSource>): string | null {
  const source = byId.get(id);
  if (source) return readableSourceReference(source);
  const location = decodeSymbolLocation(id) ?? decodeModulePath(id);
  return location ? code(location) : null;
}

/**
 * Replace the cited grounding ids in an assembled document with document-scoped
 * footnotes, and append their definitions. `sources` is every source admitted
 * to any section of the run; ids outside it are dropped.
 */
export function renderCitationFootnotes(
  markdown: string,
  sources: Iterable<GroundingSource>,
): string {
  const byId = new Map<string, GroundingSource>();
  for (const s of sources) if (!byId.has(s.sourceId)) byId.set(s.sourceId, s);

  // One number per distinct READABLE reference, in order of first citation.
  const numberOf = new Map<string, number>();
  const definitions: string[] = [];
  const footnoteFor = (id: string): number | null => {
    const source = byId.get(id);
    if (!source) return null;
    const reference = readableSourceReference(source);
    let n = numberOf.get(reference);
    if (n === undefined) {
      n = numberOf.size + 1;
      numberOf.set(reference, n);
      definitions.push(`[^${LABEL_PREFIX}${n}]: ${reference}`);
    }
    return n;
  };

  const renderCluster = (
    _match: string,
    lead: string,
    open: string | undefined,
    inner: string,
    close: string | undefined,
  ): string => {
    const numbers: number[] = [];
    for (const marker of inner.match(MARKER_RE) ?? []) {
      const body = marker.replace(/^\[\s*/, "").replace(/\]$/, "");
      for (const token of body.split(/[,;\s]+/)) {
        if (!/^(?:facts|rag|web):/.test(token)) continue;
        const n = footnoteFor(token);
        if (n !== null && !numbers.includes(n)) numbers.push(n);
      }
    }
    const refs = numbers.map((n) => `[^${LABEL_PREFIX}${n}]`).join("");
    // A bracket pair the cluster owns is dropped with it; an unmatched one
    // belongs to the surrounding prose and is kept.
    if (open && !close) return `${lead}(${refs}`;
    if (close && !open) return `${refs})`;
    return refs;
  };

  let inFence = false;
  const lines = markdown.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;
    return line
      .replace(CLUSTER_RE, renderCluster)
      .replace(BARE_ID_RE, (match, id: string) => readableBareId(id, byId) ?? match);
  });

  const body = lines.join("\n");
  return definitions.length > 0 ? `${body}\n\n${definitions.join("\n")}` : body;
}
