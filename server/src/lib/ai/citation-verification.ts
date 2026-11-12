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
 * Earlier turns count too: what the project-reading tools returned in the
 * conversation's earlier, uncompacted turns (stored in full on their reply
 * rows) is the window the #773 history digest covers, and that digest tells
 * the model "citations you drew from them stand". A citation only those turns
 * read is `verified-earlier`, not a false `not-read`.
 *
 * `[n]` resolves against the numbered retrieved excerpts and then the fused
 * code block, which continues their numbering (so the two never collide).
 * A short path naming several files read is `verified` when one of them covers
 * the cited lines, else `ambiguous`.
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
  type TranscriptPart,
  type ChatCitation,
  type ChatCitationSource,
  type ChatCitationStatus,
} from "@metis/shared";
import { CHAT_CODE_TOOL_NAMES } from "../analysis/tools/chat-code-tool-names.js";

/** One file or document the conversation retrieved or read, and the lines of it that were read. */
interface EvidenceFile {
  source: ChatCitationSource;
  /** Retrieved or read by this turn (not only by an earlier one). */
  now: boolean;
  /** Line ranges this turn read; empty when it was read as an excerpt with no line numbers. */
  ranges: Array<[number, number]>;
  /** Line ranges earlier turns' tools read. */
  earlierRanges: Array<[number, number]>;
}

/** One entry of the fused code block (#714), by its `[n]` number. */
export interface CodeEntryEvidence {
  n: number;
  path: string;
  lines: [number, number];
}

export class CitationEvidence {
  readonly files = new Map<string, EvidenceFile>();
  /** The retrieved excerpts in block order, for `[n]` references. */
  readonly excerpts: Array<{ name: string; source: ChatCitationSource }> = [];
  /** The fused code block's entries by `[n]`, numbered after the excerpts. */
  readonly codeEntries = new Map<number, CodeEntryEvidence>();

  add(path: string, source: ChatCitationSource, range?: [number, number], earlier = false): void {
    const key = normalizePath(path);
    if (!key) return;
    const entry = this.files.get(key) ?? { source, now: false, ranges: [], earlierRanges: [] };
    // A file read as code anywhere in the conversation is a repository file.
    if (source === "repo") entry.source = "repo";
    if (!earlier) entry.now = true;
    if (range) (earlier ? entry.earlierRanges : entry.ranges).push(range);
    this.files.set(key, entry);
  }
}

/** What the turn's retrieval captured (`RagContextCapture`, by shape). */
export interface RetrievedEvidence {
  /** The contexts as the model saw them: excerpts and the fused code block. */
  contexts: readonly string[];
  /** The numbered excerpts, by the name the model was shown. */
  excerpts?: readonly { name: string; source?: string }[];
  /** The fused code block's entries, numbered after the excerpts. */
  codeEntries?: readonly CodeEntryEvidence[];
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
/** The curated code tools (`source: "code"`), by the name a reply row stores. */
const CODE_TOOLS: ReadonlySet<string> = new Set(CHAT_CODE_TOOL_NAMES);

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
/**
 * An `[n]` reference to a retrieved excerpt: not a Markdown link `[n](…)`, and
 * not an index straight after an identifier or a call (`items[0]`, `f()[1]`).
 * `[1][2]` is still two references.
 */
const EXCERPT_REF = /(?<![\w)])\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\](?!\()/g;

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

/** Fold one project-reading tool result into `ev`. */
function addToolEvidence(ev: CitationEvidence, t: ToolEvidence, earlier: boolean): void {
  if (!readsProject(t)) return;
  const text = t.result!;
  const slice = SLICE_HEADER.exec(text);
  if (slice) {
    const r = range(slice[2]!, slice[3]);
    if (r) ev.add(slice[1]!, "repo", r, earlier);
    return;
  }
  if (t.source === "code") {
    for (const m of text.matchAll(LOCATOR)) {
      const r = range(m[2]!, m[3]);
      if (r) ev.add(m[1]!, "repo", r, earlier);
    }
  } else {
    for (const m of text.matchAll(EXCERPT_HEADER)) ev.add(m[1]!, "document", undefined, earlier);
  }
}

/** A stored transcript row, by the shape this module reads. */
export interface PriorRow {
  role: string;
  kind: string;
  compactedAt?: Date | null;
  parts: readonly TranscriptPart[];
}

/**
 * The project-reading tool results of a conversation's earlier turns, from
 * their reply rows. Only active (uncompacted) assistant messages: the window
 * the #773 history digest covers. A stored result carries no `source`, so a
 * curated code tool is known by its name (chat's toolset gives the code tools
 * their names first, so no other tool can carry one).
 */
export function priorToolEvidence(rows: readonly PriorRow[]): ToolEvidence[] {
  const out: ToolEvidence[] = [];
  for (const r of rows) {
    if (r.role !== "assistant" || r.kind !== "message" || r.compactedAt) continue;
    for (const p of r.parts) {
      if (p.type !== "tool_result") continue;
      out.push({
        tool: p.name,
        source: CODE_TOOLS.has(p.name) ? "code" : "metis",
        executed: p.executed !== false,
        ...(p.isError ? { isError: true } : {}),
        result: p.text,
      });
    }
  }
  return out;
}

/**
 * The evidence a turn's citations are checked against: what automatic
 * retrieval supplied and what the project-reading tools returned — this turn's
 * and, from `earlierTools` ({@link priorToolEvidence}), the conversation's
 * earlier turns'.
 */
export function collectCitationEvidence(
  retrieved: RetrievedEvidence | null | undefined,
  tools: readonly ToolEvidence[] = [],
  earlierTools: readonly ToolEvidence[] = [],
): CitationEvidence {
  const ev = new CitationEvidence();
  for (const c of retrieved?.codeEntries ?? []) {
    ev.codeEntries.set(c.n, { ...c, path: normalizePath(c.path) });
  }
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
  for (const t of tools) addToolEvidence(ev, t, false);
  for (const t of earlierTools) addToolEvidence(ev, t, true);
  return ev;
}

/** The evidence files a cited path names: the exact one, else every file it is a `/`-suffix of. */
function resolve(ev: CitationEvidence, cited: string): Array<[string, EvidenceFile]> {
  const key = normalizePath(cited);
  const exact = ev.files.get(key);
  if (exact) return [[key, exact]];
  return [...ev.files].filter(([path]) => path.endsWith(`/${key}`));
}

/** How a citation of `file` (at `lines`, if any) stands against what was read. */
function judge(file: EvidenceFile, lines: [number, number] | null): ChatCitationStatus {
  if (!lines) return file.now ? "verified" : "verified-earlier";
  if (file.now && covered(lines, file.ranges)) return "verified";
  if (file.earlierRanges.length > 0 && covered(lines, [...file.ranges, ...file.earlierRanges])) {
    return "verified-earlier";
  }
  return "span-unverified";
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

const blank = (m: string) => m.replace(/[^\n]/g, " ");

/**
 * Inline code blanked as well, for `[n]` references only: `` `arr[1]` `` is
 * code, while `` `src/a.ts:3` `` is still a path citation.
 */
function withoutInlineCode(text: string): string {
  return text.replace(/`[^`\n]*`/g, blank);
}

/** Which statuses checked out, and which of two is the better support. */
const RANK: Partial<Record<ChatCitationStatus, number>> = { verified: 2, "verified-earlier": 1 };

/** Answer text with fenced code blocks and URLs blanked out (same length, so offsets hold). */
function citableText(answer: string): string {
  return answer
    .replace(/```[\s\S]*?(?:```|$)/g, blank)
    .replace(/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/\S+/gi, blank);
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
    const hits = resolve(ev, token);
    // A bare name nothing read (or several files read), with no line, is a
    // mention, not a citation: it says nothing checkable.
    if (hits.length !== 1 && !lines && !token.includes("/")) continue;
    const cited = { text: m[0].trim(), ...(lines ? { lines } : {}) };
    if (hits.length === 0) {
      push(m.index!, { ...cited, path: normalizePath(token), status: "not-read" });
      continue;
    }
    // Several files end in the cited path: the best-supported one, when one
    // covers the citation; otherwise it is ambiguous, not unread.
    const judged = hits.map(([path, file]) => ({ path, file, status: judge(file, lines) }));
    const best = judged.reduce((a, b) => ((RANK[b.status] ?? 0) > (RANK[a.status] ?? 0) ? b : a));
    if (hits.length > 1 && (!lines || !RANK[best.status])) {
      push(m.index!, { ...cited, path: normalizePath(token), status: "ambiguous" });
      continue;
    }
    push(m.index!, { ...cited, path: best.path, status: best.status, source: best.file.source });
  }

  if (ev.excerpts.length > 0 || ev.codeEntries.size > 0) {
    for (const m of withoutInlineCode(text).matchAll(EXCERPT_REF)) {
      for (const n of m[1]!.split(",").map((x) => Number.parseInt(x.trim(), 10))) {
        if (!(n >= 1)) continue;
        const label = `[${n}]`;
        const excerpt = ev.excerpts[n - 1];
        const code = ev.codeEntries.get(n);
        if (excerpt) {
          push(m.index!, {
            text: label,
            path: excerpt.name,
            status: "verified",
            source: excerpt.source,
          });
        } else if (code) {
          push(m.index!, {
            text: label,
            path: code.path,
            lines: code.lines,
            status: "verified",
            source: "repo",
          });
        } else {
          push(m.index!, { text: label, path: "", status: "not-read" });
        }
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
