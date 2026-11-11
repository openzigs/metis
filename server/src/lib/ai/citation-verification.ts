/**
 * #2242 — check a chat answer's citations against what its turn retrieved or
 * read, deterministically, before they are shown.
 *
 * Chat is told to cite `filePath:startLine-endLine` (#715), but nothing checked
 * a citation: a fabricated path or line range read exactly like a real one.
 * Here every citation is resolved against the turn's evidence:
 *
 *   - the excerpts automatic retrieval put in the prompt (by name: a chunk has
 *     no line numbers), and the `path:start-end` locators of the fused code
 *     block (#714);
 *   - what the project-reading tools returned: `read_file_slice`'s
 *     `path (lines a-b of n)` header, the `path:start-end` locators the code
 *     search tools list, and the excerpt names `search-knowledge` lists.
 *
 * A citation is `verified` when its file is in the evidence and every cited
 * line lies within lines that were read; `span-unverified` when the file was
 * read but not those lines; `not-read` when nothing the turn read is that
 * file. MCP and other tools are not evidence: what they return is not known
 * to be the project's content (as for grounding, #439).
 *
 * What counts as a citation: a path-shaped token (a name with an extension)
 * that carries a line reference, or contains a `/`, or names a file the turn
 * read, plus an `[n]` reference to the n-th retrieved excerpt. A bare file name
 * the turn never read and that cites no line ("add a `config.yaml`") is a
 * mention, not a citation, and is left alone. Fenced code blocks and URLs are
 * skipped: an import path or a link is not a source.
 */
import {
  MAX_CHAT_CITATIONS,
  type ChatCitation,
  type ChatCitationSource,
  type ChatCitationStatus,
} from "@metis/shared";

/** One file or document the turn retrieved or read, and the lines of it that were read. */
interface EvidenceFile {
  source: ChatCitationSource;
  /** Line ranges read; empty when it was read as an excerpt with no line numbers. */
  ranges: Array<[number, number]>;
}

export class CitationEvidence {
  readonly files = new Map<string, EvidenceFile>();
  /** The retrieved excerpts in block order, for `[n]` references. */
  readonly excerpts: Array<{ name: string; source: ChatCitationSource }> = [];

  add(path: string, source: ChatCitationSource, range?: [number, number]): void {
    const key = normalizePath(path);
    if (!key) return;
    const entry = this.files.get(key) ?? { source, ranges: [] };
    // A file read as code anywhere in the turn is a repository file.
    if (source === "repo") entry.source = "repo";
    if (range) entry.ranges.push(range);
    this.files.set(key, entry);
  }
}

/** What the turn's retrieval captured (`RagContextCapture`, by shape). */
export interface RetrievedEvidence {
  /** The contexts as the model saw them: excerpts and the fused code block. */
  contexts: readonly string[];
  /** The numbered excerpts, by the name the model was shown. */
  excerpts?: readonly { name: string; source?: string }[];
}

/** What one tool call returned (`ChatToolRecord`, by shape). */
export interface ToolEvidence {
  tool?: string;
  source?: string;
  executed: boolean;
  isError?: boolean;
  result?: string;
}

/** The METIS tools whose results are the project's own files and documents. */
const PROJECT_FILE_TOOLS: ReadonlySet<string> = new Set(["search-knowledge"]);

/**
 * A `path:start-end` (or `path:line`) locator, as the code tools and the fused
 * block print them. The lookbehind starts a match only where a path can start,
 * so a long run of path characters (a minified line a tool read) is scanned once,
 * not once per position: linear, where the bare pattern is quadratic.
 */
const LOCATOR =
  /(?<![A-Za-z0-9_.\-/])([A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,7}):(\d{1,7})(?:-(\d{1,7}))?/g;
/** `read_file_slice`'s header: `path (lines a-b of n)`. */
const SLICE_HEADER = /^(\S+) \(lines (\d{1,7})-(\d{1,7}) of \d+\)/m;
/** An excerpt header in a retrieved block or a `search-knowledge` result: `[n] name#position`. */
const EXCERPT_HEADER = /^\[\d+\] (?:\[[^\]\n]*\] )?(\S+?)#\d+\b/gm;

/**
 * A path-shaped token in an answer, then an optional line reference: `:12`,
 * `:12-40`, `#L12`, `#L12-L40`, or `lines 12-40` / `line 12` after it.
 */
const CITATION =
  /(?<![A-Za-z0-9_.\-/@])([A-Za-z0-9_.\-/]*[A-Za-z0-9_-]\.[A-Za-z][A-Za-z0-9]{0,7})(?![A-Za-z0-9])(?:(?::|#L)(\d{1,7})(?:\s*[-–]\s*L?(\d{1,7}))?|[`'")\]]?[\s(,]*\blines?\s+(\d{1,7})(?:\s*[-–]\s*(\d{1,7}))?)?/g;
/** An `[n]` reference to a retrieved excerpt (not a Markdown link `[n](…)`). */
const EXCERPT_REF = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

/** Repository-relative: no `./`, no leading `/`, forward slashes. */
export function normalizePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/|\/)+/, "");
}

function range(start: string, end?: string): [number, number] | null {
  const a = Number(start);
  const b = end ? Number(end) : a;
  if (!(a >= 1) || !(b >= 1)) return null;
  return a <= b ? [a, b] : [b, a];
}

function readsProject(t: ToolEvidence): boolean {
  if (!t.executed || t.isError || !t.result) return false;
  if (t.source === "code") return true;
  return t.source === "metis" && t.tool !== undefined && PROJECT_FILE_TOOLS.has(t.tool);
}

/**
 * The evidence a turn's citations are checked against: what automatic
 * retrieval supplied and what the project-reading tools returned.
 */
export function collectCitationEvidence(
  retrieved: RetrievedEvidence | null | undefined,
  tools: readonly ToolEvidence[] = [],
): CitationEvidence {
  const ev = new CitationEvidence();
  for (const e of retrieved?.excerpts ?? []) {
    const source: ChatCitationSource = e.source === "repo" ? "repo" : "document";
    ev.excerpts.push({ name: normalizePath(e.name), source });
    ev.add(e.name, source);
  }
  for (const text of retrieved?.contexts ?? []) {
    // A multi-product block (#2238) records no `excerpts`: read its headers.
    if (!retrieved?.excerpts) {
      for (const m of text.matchAll(EXCERPT_HEADER)) ev.add(m[1]!, "document");
    }
    for (const m of text.matchAll(LOCATOR)) {
      const r = range(m[2]!, m[3]);
      if (r) ev.add(m[1]!, "repo", r);
    }
  }
  for (const t of tools) {
    if (!readsProject(t)) continue;
    const text = t.result!;
    const slice = SLICE_HEADER.exec(text);
    if (slice) {
      const r = range(slice[2]!, slice[3]);
      if (r) ev.add(slice[1]!, "repo", r);
      continue;
    }
    if (t.source === "code") {
      for (const m of text.matchAll(LOCATOR)) {
        const r = range(m[2]!, m[3]);
        if (r) ev.add(m[1]!, "repo", r);
      }
    } else {
      for (const m of text.matchAll(EXCERPT_HEADER)) ev.add(m[1]!, "document");
    }
  }
  return ev;
}

/** The evidence file a cited path names: exact, else the one file it is a `/`-suffix of. */
function resolve(ev: CitationEvidence, cited: string): [string, EvidenceFile] | null {
  const key = normalizePath(cited);
  const exact = ev.files.get(key);
  if (exact) return [key, exact];
  const hits = [...ev.files].filter(([path]) => path.endsWith(`/${key}`));
  return hits.length === 1 ? hits[0]! : null;
}

/** Whether every line of `[a, b]` lies within the union of `ranges`. */
function covered([a, b]: [number, number], ranges: ReadonlyArray<[number, number]>): boolean {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0]);
  let next = a;
  for (const [s, e] of sorted) {
    if (s > next) break;
    if (e >= next) next = e + 1;
    if (next > b) return true;
  }
  return next > b;
}

/** Answer text with fenced code blocks and URLs blanked out (same length, so offsets hold). */
function citableText(answer: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return answer
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank);
}

/**
 * Every citation in `answer`, checked against `ev`, in the order written; the
 * same citation twice is listed once. At most {@link MAX_CHAT_CITATIONS}.
 */
export function verifyCitations(answer: string, ev: CitationEvidence): ChatCitation[] {
  if (!answer) return [];
  const text = citableText(answer);
  const found: Array<{ at: number; citation: ChatCitation }> = [];
  const seen = new Set<string>();
  const push = (at: number, c: ChatCitation) => {
    const key = `${c.text}|${c.path}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ at, citation: c });
  };

  for (const m of text.matchAll(CITATION)) {
    const token = m[1]!;
    const start = m[2] ?? m[4];
    const lines = start ? range(start, m[3] ?? m[5]) : null;
    const resolved = resolve(ev, token);
    // A bare name the turn never read, with no line, is a mention, not a citation.
    if (!resolved && !lines && !token.includes("/")) continue;
    let status: ChatCitationStatus;
    if (!resolved) status = "not-read";
    else if (!lines) status = "verified";
    else status = covered(lines, resolved[1].ranges) ? "verified" : "span-unverified";
    push(m.index!, {
      text: m[0].trim(),
      path: resolved ? resolved[0] : normalizePath(token),
      ...(lines ? { lines } : {}),
      status,
      ...(resolved ? { source: resolved[1].source } : {}),
    });
  }

  if (ev.excerpts.length > 0) {
    for (const m of text.matchAll(EXCERPT_REF)) {
      for (const n of m[1]!.split(",").map((x) => Number.parseInt(x.trim(), 10))) {
        const excerpt = ev.excerpts[n - 1];
        push(m.index!, {
          text: `[${n}]`,
          path: excerpt?.name ?? "",
          status: excerpt ? "verified" : "not-read",
          ...(excerpt ? { source: excerpt.source } : {}),
        });
      }
    }
  }

  return found
    .sort((x, y) => x.at - y.at)
    .slice(0, MAX_CHAT_CITATIONS)
    .map((f) => f.citation);
}

/** The reply-row `meta` entry for `citations`; empty when the answer cited nothing. */
export function citationsMeta(citations: readonly ChatCitation[]): Record<string, ChatCitation[]> {
  return citations.length > 0 ? { citations: [...citations] } : {};
}
