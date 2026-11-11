/**
 * #2229 — the authored form of a document-understanding corpus item, and the
 * labels it yields.
 *
 * A document is written once, as `frd.src.md`, with its labels marked inline,
 * so a label's source span is the document's own text by construction:
 *
 *   - `[[R12 The clinic administrator shall ...]]` marks requirement R12; the
 *     text inside is its source span.
 *   - `[[A3 as soon as practical]]` marks the span of ambiguity A3.
 *   - a trailer between `<!-- labels` and `-->` describes each ambiguity:
 *     `A3 [vague-term] @R12,R14: what is unclear => the question a BA would want raised`.
 *     The `@` list names requirements the ambiguity bears on, and their spans
 *     join its own: a conflict has two sides, and a gap the document is
 *     silent on has no words of its own to mark, only the requirement it
 *     leaves incomplete.
 *
 * {@link parseFrdSource} strips the markers, returning the blocks the Word
 * renderer writes and the labels `labels.json` holds. Markers do not nest.
 */

/** One block of the document, as the Word renderer writes it. */
export type FrdBlock =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "numbered"; text: string }
  | { kind: "table"; rows: string[][] };

export const AMBIGUITY_KINDS = [
  "vague-term",
  "undefined-term",
  "escape-clause",
  "conflict",
  "missing",
  "tbd",
] as const;
export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];

export interface LabelledRequirement {
  id: string;
  /** The heading the span sits under (the nearest one above it). */
  section: string;
  span: string;
}

export interface LabelledAmbiguity {
  id: string;
  kind: AmbiguityKind;
  description: string;
  /** The question a business analyst would want raised. */
  question: string;
  /** The requirements it bears on. */
  requirements: string[];
  /** Its own marked spans, then the spans of the requirements it names. */
  spans: string[];
  /** The sections of its spans, in document order, without repeats. */
  sections: string[];
}

export interface FrdLabels {
  /** Every heading, in document order. */
  sections: string[];
  requirements: LabelledRequirement[];
  ambiguities: LabelledAmbiguity[];
}

export interface ParsedFrdSource {
  title: string;
  blocks: FrdBlock[];
  labels: FrdLabels;
}

const MARKER = /\[\[([RA]\d+) ([^\]]+?)\]\]/g;
const TRAILER = /<!-- labels\n([\s\S]*?)\n-->/;
const AMBIGUITY_LINE = /^(A\d+) \[([a-z-]+)\](?: @([R\d,]+))?: (.+?) => (.+)$/;

/** `text` with its markers removed, and each marker's id and span. */
function stripMarkers(text: string): { text: string; marks: Array<{ id: string; span: string }> } {
  const marks: Array<{ id: string; span: string }> = [];
  const out = text.replace(MARKER, (_m, id: string, span: string) => {
    marks.push({ id, span });
    return span;
  });
  if (out.includes("[[") || out.includes("]]")) {
    throw new Error(`an unclosed or nested label marker in: ${text.slice(0, 120)}`);
  }
  return { text: out, marks };
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/** Parse `frd.src.md`. Throws on a malformed marker, trailer line or label reference. */
export function parseFrdSource(source: string): ParsedFrdSource {
  const trailer = TRAILER.exec(source);
  const body = (trailer ? source.slice(0, trailer.index) : source).replace(/\r\n/g, "\n");
  const blocks: FrdBlock[] = [];
  const sections: string[] = [];
  const requirements: LabelledRequirement[] = [];
  const ambiguitySpans = new Map<string, Array<{ span: string; section: string }>>();
  let section = "(start)";
  let title = "";

  const record = (marks: Array<{ id: string; span: string }>): void => {
    for (const { id, span } of marks) {
      if (id.startsWith("R")) {
        if (requirements.some((r) => r.id === id))
          throw new Error(`requirement ${id} marked twice`);
        requirements.push({ id, section, span });
      } else {
        const list = ambiguitySpans.get(id) ?? [];
        list.push({ span, section });
        ambiguitySpans.set(id, list);
      }
    }
  };

  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length === 0) return;
    const { text, marks } = stripMarkers(paragraph.join(" "));
    blocks.push({ kind: "paragraph", text });
    record(marks);
    paragraph = [];
  };

  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const heading = /^(#{1,3}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const text = heading[2]!.trim();
      if (MARKER.test(text)) throw new Error(`a label marker in heading: ${text}`);
      MARKER.lastIndex = 0;
      blocks.push({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3, text });
      sections.push(text);
      section = text;
      if (!title && heading[1] === "#") title = text;
      continue;
    }
    const item = /^(- |\d+\. )(.+)$/.exec(line);
    if (item) {
      flush();
      const { text, marks } = stripMarkers(item[2]!.trim());
      blocks.push({ kind: item[1] === "- " ? "bullet" : "numbered", text });
      record(marks);
      continue;
    }
    if (line.trim().startsWith("|")) {
      flush();
      const rows: string[][] = [];
      for (; i < lines.length && lines[i]!.trim().startsWith("|"); i++) {
        const cells = tableCells(lines[i]!);
        if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
        const row: string[] = [];
        for (const cell of cells) {
          const { text, marks } = stripMarkers(cell);
          row.push(text);
          record(marks);
        }
        rows.push(row);
      }
      i--;
      blocks.push({ kind: "table", rows });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    paragraph.push(line.trim());
  }
  flush();

  const reqById = new Map(requirements.map((r) => [r.id, r]));
  const ambiguities: LabelledAmbiguity[] = [];
  const described = new Set<string>();
  for (const raw of (trailer?.[1] ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = AMBIGUITY_LINE.exec(line);
    if (!m) throw new Error(`a malformed ambiguity line: ${line}`);
    const [, id, kind, refs, description, question] = m as unknown as [
      string,
      string,
      string,
      string | undefined,
      string,
      string,
    ];
    if (!(AMBIGUITY_KINDS as readonly string[]).includes(kind)) {
      throw new Error(`${id}: unknown ambiguity kind ${kind}`);
    }
    if (described.has(id)) throw new Error(`ambiguity ${id} described twice`);
    described.add(id);
    const linked = refs ? refs.split(",").filter(Boolean) : [];
    for (const r of linked) {
      if (!reqById.has(r)) throw new Error(`${id} names ${r}, which no marker defines`);
    }
    const anchored = [...(ambiguitySpans.get(id) ?? []), ...linked.map((r) => reqById.get(r)!)];
    if (anchored.length === 0) throw new Error(`${id} has no span and names no requirement`);
    ambiguities.push({
      id,
      kind: kind as AmbiguityKind,
      description: description.trim(),
      question: question.trim(),
      requirements: linked,
      spans: anchored.map((a) => a.span),
      sections: [...new Set(anchored.map((a) => a.section))],
    });
  }
  for (const id of ambiguitySpans.keys()) {
    if (!described.has(id)) throw new Error(`ambiguity ${id} is marked but not described`);
  }
  if (!title) throw new Error("the document has no level-1 title");
  return { title, blocks, labels: { sections, requirements, ambiguities } };
}
