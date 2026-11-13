/**
 * Atlassian Document Format → Markdown — #2244.
 *
 * Jira Cloud's REST API v3 returns rich-text fields (`description`, textarea
 * custom fields, comments) as an ADF JSON tree rather than a string. Stored
 * as-is, a requirement body reads `{"type":"doc","version":1,...}`. This turns
 * the tree into Markdown an analyst (and the RAG chunker) can read: headings,
 * paragraphs, marks, links, lists, task lists, tables, code blocks, quotes,
 * panels, mentions, emoji, dates and status lozenges.
 *
 * Unknown node types degrade to their text content, never to JSON. Link
 * targets are kept only for http(s) and mailto URLs, so a `javascript:` href
 * in a Jira description never becomes a clickable Markdown link — and text
 * from the issue is escaped (#2260), so literal `[x](javascript:…)` or `<b>`
 * typed into Jira reads as those characters rather than forming a link or HTML.
 *
 * Reference: https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */

interface AdfNode {
  type?: unknown;
  text?: unknown;
  attrs?: Record<string, unknown>;
  marks?: unknown;
  content?: unknown;
}

/** Nesting beyond this is not descended into; bounds recursion on hostile input. */
const MAX_DEPTH = 64;

const INLINE_TYPES = new Set([
  "text",
  "hardBreak",
  "mention",
  "emoji",
  "inlineCard",
  "date",
  "status",
  "placeholder",
  "mediaInline",
]);

/** True for an ADF root: `{ type: "doc", content: [...] }`. */
export function isAdfDocument(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const node = value as AdfNode;
  return node.type === "doc" && Array.isArray(node.content);
}

/** Render an ADF document (or any ADF node) as Markdown. */
export function adfToMarkdown(doc: unknown): string {
  if (!doc || typeof doc !== "object") return "";
  const node = doc as AdfNode;
  const body = node.type === "doc" ? renderBlocks(childrenOf(node), 0) : renderBlock(node, 0);
  return body.replace(/\n{3,}/g, "\n\n").trim();
}

function childrenOf(node: AdfNode): AdfNode[] {
  if (!Array.isArray(node.content)) return [];
  return node.content.filter((c): c is AdfNode => !!c && typeof c === "object");
}

function attr(node: AdfNode, key: string): unknown {
  return node.attrs && typeof node.attrs === "object" ? node.attrs[key] : undefined;
}

function attrString(node: AdfNode, key: string): string {
  const v = attr(node, key);
  return typeof v === "string" ? v : "";
}

function isInline(node: AdfNode): boolean {
  return typeof node.type === "string" && INLINE_TYPES.has(node.type);
}

const LIST_TYPES = new Set(["bulletList", "orderedList", "taskList", "decisionList"]);

/**
 * Render a run of block nodes, grouping stray inline nodes into a paragraph.
 * `separator` is the text placed before each part after the first, or a
 * function of the node that starts that part.
 */
function renderBlocks(
  nodes: AdfNode[],
  depth: number,
  separator: string | ((next: AdfNode) => string) = "\n\n",
): string {
  const parts: { text: string; first: AdfNode }[] = [];
  let inlineRun: AdfNode[] = [];
  const flush = () => {
    if (inlineRun.length > 0)
      parts.push({ text: renderInline(inlineRun, depth), first: inlineRun[0] });
    inlineRun = [];
  };
  for (const node of nodes) {
    if (isInline(node)) {
      inlineRun.push(node);
      continue;
    }
    flush();
    parts.push({ text: renderBlock(node, depth), first: node });
  }
  flush();
  const sep = typeof separator === "string" ? () => separator : separator;
  return parts
    .filter((p) => p.text.trim().length > 0)
    .map((p, i) => (i === 0 ? p.text : sep(p.first) + p.text))
    .join("");
}

function renderBlock(node: AdfNode, depth: number): string {
  if (depth > MAX_DEPTH) return "";
  const next = depth + 1;
  const children = childrenOf(node);
  switch (node.type) {
    case "paragraph":
      return renderInline(children, next);
    case "heading": {
      const raw = Number(attr(node, "level"));
      const level = Number.isInteger(raw) ? Math.min(Math.max(raw, 1), 6) : 1;
      return `${"#".repeat(level)} ${renderInline(children, next, "space")}`;
    }
    case "bulletList":
      return children.map((item) => renderListItem(item, "- ", next)).join("\n");
    case "orderedList": {
      const raw = Number(attr(node, "order"));
      const start = Number.isInteger(raw) && raw >= 0 ? raw : 1;
      return children.map((item, i) => renderListItem(item, `${start + i}. `, next)).join("\n");
    }
    case "taskList":
      return children
        .map((item) => {
          if (item.type === "taskList") return indent(renderBlock(item, next), "  ");
          const box = attr(item, "state") === "DONE" ? "[x]" : "[ ]";
          return renderListItem(item, `- ${box} `, next);
        })
        .join("\n");
    case "decisionList":
      return children.map((item) => renderListItem(item, "- ", next)).join("\n");
    case "codeBlock":
      return renderCodeBlock(node, children);
    case "blockquote":
      return quote(renderBlocks(children, next));
    case "panel": {
      const label = escapeText(attrString(node, "panelType"));
      const body = renderBlocks(children, next);
      return quote(label ? `**${capitalise(label)}:** ${body}` : body);
    }
    case "expand":
    case "nestedExpand": {
      const title = escapeText(attrString(node, "title"));
      const body = renderBlocks(children, next);
      return title ? `**${title}**\n\n${body}` : body;
    }
    case "rule":
      return "---";
    case "table":
      return renderTable(children, next);
    case "mediaSingle":
    case "mediaGroup":
      return children.map((m) => renderMedia(m)).join("\n");
    case "media":
      return renderMedia(node);
    case "blockCard":
    case "embedCard": {
      const url = safeUrl(attrString(node, "url"));
      return url ? `<${url}>` : "";
    }
    default:
      if (typeof node.text === "string") return escapeText(node.text, { lineStart: true });
      return renderBlocks(children, next);
  }
}

function renderListItem(item: AdfNode, marker: string, depth: number): string {
  const children = childrenOf(item);
  // A list item holds blocks (paragraph, nested list): a second paragraph needs a blank
  // line or it merges into the first, while a nested list stays tight under its parent.
  // A task or decision item holds inline nodes, so a single newline is enough (#2260).
  const tight = item.type === "taskItem" || item.type === "decisionItem";
  const body = renderBlocks(children, depth, (next) =>
    tight || LIST_TYPES.has(next.type as string) ? "\n" : "\n\n",
  );
  const pad = " ".repeat(marker.length);
  const [first = "", ...rest] = body.split("\n");
  return [marker + first, ...rest.map((line) => (line ? pad + line : line))].join("\n");
}

function renderCodeBlock(node: AdfNode, children: AdfNode[]): string {
  const code = children.map((c) => (typeof c.text === "string" ? c.text : "")).join("");
  const language = attrString(node, "language").replace(/[^\w+#.-]/g, "");
  // A fence longer than any backtick run inside the code, so it cannot close early.
  const longestRun = Math.max(0, ...(code.match(/`+/g) ?? []).map((r) => r.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${code}\n${fence}`;
}

function renderTable(rows: AdfNode[], depth: number): string {
  const grid = rows
    .filter((r) => r.type === "tableRow")
    .map((row) =>
      childrenOf(row).map((cell) =>
        renderBlocks(childrenOf(cell), depth, " ")
          .replace(/\s*\n\s*/g, " ")
          // Text already arrives with its own `\` escaped, so a pipe behind an even run of
          // backslashes is a real cell boundary: escape it. An odd run already escapes it.
          .replace(/(\\*)\|/g, (run, slashes: string) =>
            slashes.length % 2 === 0 ? `${slashes}\\|` : run,
          )
          .trim(),
      ),
    );
  if (grid.length === 0) return "";
  const width = Math.max(...grid.map((r) => r.length));
  if (width === 0) return "";
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, i) => cells[i] ?? "").join(" | ")} |`;
  const [header, ...body] = grid;
  return [line(header), line(Array(width).fill("---")), ...body.map(line)].join("\n");
}

function renderMedia(node: AdfNode): string {
  if (node.type !== "media") return "";
  const alt = escapeText(attrString(node, "alt"));
  return alt ? `[attachment: ${alt}]` : "[attachment]";
}

type MarkName = "link" | "strong" | "em" | "strike";
const MARK_ORDER: readonly MarkName[] = ["link", "strong", "em", "strike"];

interface OpenMark {
  type: MarkName;
  /** A link's (already safe) target; empty for the other marks. */
  href: string;
}

interface TextRun {
  kind: "run";
  text: string;
  marks: OpenMark[];
  code: boolean;
  /** `text` split at its edges: markers must hug the text, so edge whitespace stays outside. */
  lead: string;
  core: string;
  trail: string;
}

type InlineItem = TextRun | AdfNode;

/** Where an inline run starts: a line (block syntax can form), after a space, or unknown. */
type InlineStart = "line" | "space" | "unknown";

/** Per run: how many open marks it keeps, which it opens (outermost first), the stack after. */
interface MarkStep {
  keep: number;
  opens: OpenMark[];
  stack: OpenMark[];
}

/** How far ahead a mark's lifetime is counted; it only orders the marks a run opens. */
const LIFETIME_HORIZON = 32;

/**
 * Render a run of inline nodes. Marks are opened and closed across the run
 * rather than per text node (#2260): two adjacent bold nodes become one
 * `**foobar**`, and bold followed by bold-italic nests as `**foo*bar***`
 * instead of fusing into `**foo*****bar***`. A run keeps every open mark it
 * still carries, and opens its new marks longest-lived first, so the mark that
 * ends first is innermost: bold-italic then italic is `***a**b*`, not the
 * fused `***a****b*`.
 */
function renderInline(nodes: AdfNode[], depth: number, start: InlineStart = "line"): string {
  if (depth > MAX_DEPTH) return "";
  const items = mergeTextRuns(nodes);
  const steps = planMarks(items);
  // Inline nodes render first: the text before one escapes against its first character.
  const shown = items.map((item) => (isRun(item) ? "" : renderInlineNode(item, depth, false)));
  let out = "";
  let atLineStart = start === "line";
  /** Edge punctuation moved past the closers that end the run before it (#2260). */
  let tail = "";
  const open: OpenMark[] = [];
  const lastChar = (): string | undefined => {
    if (out.length === 0) return start === "unknown" ? undefined : "";
    const low = out.charCodeAt(out.length - 1);
    return out.slice(low >= 0xdc00 && low <= 0xdfff ? -2 : -1);
  };
  // Close the marks above `keep`, moving trailing whitespace outside them: `**a **` does not render.
  const closeTo = (keep: number) => {
    if (open.length <= keep) return;
    // Scan back from the end: an unanchored `/\s*$/` is quadratic in any earlier whitespace run.
    let cut = out.length;
    while (cut > 0 && /\s/.test(out[cut - 1])) cut -= 1;
    const trail = out.slice(cut);
    out = out.slice(0, cut);
    while (open.length > keep) out += closer(open.pop() as OpenMark);
    out += tail + trail;
    tail = "";
  };
  /** The marks that close straight after item `i`, innermost first. */
  const closingAfter = (i: number): OpenMark[] => {
    const next = items[i + 1];
    const keep = next && isRun(next) ? steps[i + 1].keep : 0;
    return steps[i].stack.slice(keep).reverse();
  };
  /** The first character emitted for item `i + 1`, past any closers; "" at the end. */
  const firstCharAfter = (i: number): string | undefined => {
    const next = items[i + 1];
    if (!next) return "";
    if (!isRun(next)) return shown[i + 1] ? shown[i + 1][0] : undefined;
    if (next.lead) return next.lead[0];
    const opens = steps[i + 1].opens;
    if (opens.length > 0) return opener(opens[0])[0];
    return next.code ? "`" : next.core[0];
  };

  items.forEach((item, i) => {
    if (!isRun(item)) {
      closeTo(0);
      const text = atLineStart ? renderInlineNode(item, depth, true) : shown[i];
      out += text;
      if (text.trim()) atLineStart = false;
      if (text.endsWith("\n")) atLineStart = true;
      return;
    }
    const { keep, opens } = steps[i];
    closeTo(keep);
    if (item.core.length === 0) {
      out += item.text;
      if (item.text.includes("\n")) atLineStart = true;
      return;
    }
    out += item.lead;
    if (item.lead.includes("\n")) atLineStart = true;
    const closing = closingAfter(i);
    const beyond = firstCharAfter(i);
    const after = item.trail ? item.trail[0] : closing.length ? closerChar(closing[0]) : beyond;
    if (item.code) {
      for (const mark of opens) out += openMark(open, mark);
      out += codeSpan(item.core) + item.trail;
      atLineStart = item.trail.includes("\n");
      return;
    }
    const chars = Array.from(item.core);
    // A delimiter between a word character and punctuation is not flanking, so it opens or
    // closes nothing (`x**\*y**`): such edge punctuation goes outside the mark (#2260).
    const before = lastChar();
    let lead = 0;
    if (!item.lead && opens.some(isEmphasis) && isWord(before)) {
      while (lead < chars.length && isPunct(chars[lead])) lead += 1;
      if (!isWord(chars[lead])) lead = 0;
    }
    let trail = 0;
    if (!item.trail && closing.some(isEmphasis) && isWord(beyond)) {
      while (trail < chars.length - lead && isPunct(chars[chars.length - 1 - trail])) trail += 1;
      if (trail === chars.length - lead || !isWord(chars[chars.length - 1 - trail])) trail = 0;
    }
    if (lead > 0) {
      out += escapeChars(chars.slice(0, lead), {
        before,
        after: opener(opens[0])[0],
        inLink: open.some(isLink),
      });
    }
    for (const mark of opens) out += openMark(open, mark);
    out += escapeChars(chars.slice(lead, chars.length - trail), {
      before: lastChar(),
      after: trail > 0 ? closerChar(closing[0]) : after,
      lineStart: atLineStart && lead === 0 && opens.length === 0,
      inLink: item.marks.some(isLink),
    });
    if (trail > 0) {
      const kept = open.slice(0, open.length - closing.length);
      tail = escapeChars(chars.slice(chars.length - trail), {
        before: closer(closing[closing.length - 1]).slice(-1),
        after: beyond,
        inLink: kept.some(isLink),
      });
    }
    out += item.trail;
    atLineStart = item.trail.includes("\n");
  });
  closeTo(0);
  return out;
}

function openMark(open: OpenMark[], mark: OpenMark): string {
  open.push(mark);
  return opener(mark);
}

/**
 * Decide, per run, which open marks it keeps and in what order it opens the rest.
 * A run keeps the longest bottom of the stack whose marks it still carries (a set
 * comparison, not a positional one); the marks it opens are ordered by how many
 * runs they last, longest outermost, so the mark that ends first is on top.
 */
function planMarks(items: InlineItem[]): MarkStep[] {
  let stack: OpenMark[] = [];
  return items.map((item, i) => {
    if (!isRun(item)) {
      stack = [];
      return { keep: 0, opens: [], stack };
    }
    let keep = 0;
    while (keep < stack.length && item.marks.some((m) => sameMark(m, stack[keep]))) keep += 1;
    const kept = stack.slice(0, keep);
    const opens =
      item.core.length === 0 ? [] : item.marks.filter((m) => !kept.some((k) => sameMark(k, m)));
    const life = new Map(opens.map((m) => [m, lifetime(items, i, m)]));
    opens.sort(
      (a, b) =>
        (life.get(b) as number) - (life.get(a) as number) ||
        MARK_ORDER.indexOf(a.type) - MARK_ORDER.indexOf(b.type),
    );
    stack = [...kept, ...opens];
    return { keep, opens, stack };
  });
}

/** How many runs after item `i` still carry `mark`, up to the horizon. */
function lifetime(items: InlineItem[], i: number, mark: OpenMark): number {
  let n = 0;
  for (let j = i + 1; j < items.length && n < LIFETIME_HORIZON; j += 1) {
    const item = items[j];
    if (!isRun(item) || !item.marks.some((m) => sameMark(m, mark))) break;
    n += 1;
  }
  return n;
}

/** Fold adjacent text nodes carrying the same marks into one run; other nodes pass through. */
function mergeTextRuns(nodes: AdfNode[]): InlineItem[] {
  const items: InlineItem[] = [];
  for (const node of nodes) {
    if (node.type !== "text") {
      items.push(node);
      continue;
    }
    if (typeof node.text !== "string" || node.text.length === 0) continue;
    const run: TextRun = {
      kind: "run",
      text: node.text,
      ...marksOf(node.marks),
      lead: "",
      core: "",
      trail: "",
    };
    const prev = items[items.length - 1];
    if (prev && isRun(prev) && sameMarks(prev, run)) prev.text += run.text;
    else items.push(run);
  }
  for (const item of items) if (isRun(item)) splitEdges(item);
  return items;
}

/** Split a run at its edge whitespace with index scans: a `^\s*…\s*$` regex is quadratic. */
function splitEdges(run: TextRun): void {
  const { text } = run;
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) start += 1;
  let end = text.length;
  while (end > start && /\s/.test(text[end - 1])) end -= 1;
  run.lead = text.slice(0, start);
  run.core = text.slice(start, end);
  run.trail = text.slice(end);
}

function isRun(item: InlineItem): item is TextRun {
  return (item as TextRun).kind === "run";
}

function isLink(mark: OpenMark): boolean {
  return mark.type === "link";
}

function isEmphasis(mark: OpenMark): boolean {
  return mark.type !== "link";
}

function marksOf(marks: unknown): { marks: OpenMark[]; code: boolean } {
  const byType = new Map<string, AdfNode>();
  if (Array.isArray(marks)) {
    for (const m of marks) {
      if (m && typeof m === "object" && typeof (m as AdfNode).type === "string") {
        byType.set((m as AdfNode).type as string, m as AdfNode);
      }
    }
  }
  const code = byType.has("code");
  const out: OpenMark[] = [];
  for (const type of MARK_ORDER) {
    const mark = byType.get(type);
    if (!mark) continue;
    if (type === "link") {
      const href = safeUrl(attrString(mark, "href"));
      if (href) out.push({ type, href });
    } else if (!code) {
      // A code span's content is literal, so emphasis inside it would show as asterisks.
      out.push({ type, href: "" });
    }
  }
  return { marks: out, code };
}

function sameMark(a: OpenMark, b: OpenMark): boolean {
  return a.type === b.type && a.href === b.href;
}

function sameMarks(a: TextRun, b: TextRun): boolean {
  return (
    a.code === b.code &&
    a.marks.length === b.marks.length &&
    a.marks.every((m, i) => sameMark(m, b.marks[i]))
  );
}

function opener(mark: OpenMark): string {
  if (mark.type === "link") return "[";
  return mark.type === "strong" ? "**" : mark.type === "em" ? "*" : "~~";
}

function closer(mark: OpenMark): string {
  return mark.type === "link" ? `](${mark.href})` : opener(mark);
}

function closerChar(mark: OpenMark): string {
  return closer(mark)[0];
}

function codeSpan(core: string): string {
  const longestRun = Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(longestRun + 1);
  const pad = core.startsWith("`") || core.endsWith("`") ? " " : "";
  return `${ticks}${pad}${core}${pad}${ticks}`;
}

/**
 * The characters around escaped text. `""` is a boundary (start or end of the
 * paragraph), which CommonMark treats as whitespace; `undefined` is unknown,
 * and every rule escapes when it cannot rule syntax out.
 */
interface EscapeContext {
  before?: string;
  after?: string;
  /** The text starts a line, where block syntax (`- `, `# `, `> `, `1. `) can form. */
  lineStart?: boolean;
  /** The text sits inside link text, where any bracket can end the link. */
  inLink?: boolean;
}

/**
 * Escape text so Markdown reads it as the characters it is (#2260): no
 * emphasis, strikethrough, code span, link, image, autolink, raw HTML or block
 * can form from what was typed into Jira. Only a character that could form
 * syntax where it stands is escaped, because plain-text readers of the body
 * (the requirement edit field, acceptance-criteria parsing, the RAG chunker)
 * see the backslashes: `snake_case_name`, `2 * 3`, `[1]` and `R&D` stay as
 * typed. Pipes are left to the table renderer, the only place they mean anything.
 */
function escapeText(text: string, ctx: EscapeContext = {}): string {
  return escapeChars(Array.from(text), ctx);
}

const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

function escapeChars(chars: string[], ctx: EscapeContext): string {
  const escaped = chars.map(() => false);
  const at = (i: number): string | undefined =>
    i < 0 ? ctx.before : i >= chars.length ? ctx.after : chars[i];
  const esc = (i: number) => {
    escaped[i] = true;
  };
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (c === "*" || c === "_" || c === "~") {
      let j = i;
      while (j < chars.length && chars[j] === c) j += 1;
      if (!inertDelimiter(c, at(i - 1), at(j))) for (let k = i; k < j; k += 1) esc(k);
      i = j - 1;
      continue;
    }
    const next = at(i + 1);
    switch (c) {
      case "\\":
        // A backslash before ASCII punctuation is an escape, and would eat that character.
        if (next === undefined || ASCII_PUNCT.test(next)) esc(i);
        break;
      case "`":
        esc(i);
        break;
      case "[":
        if (ctx.inLink) esc(i);
        break;
      case "]":
        // `](` is the only way text brackets become a link: no reference definition can
        // exist, since a line-leading `[` is escaped below.
        if (ctx.inLink || next === undefined || next === "(") esc(i);
        break;
      case "!":
        if (next === undefined || next === "[") esc(i);
        break;
      case "<":
        if (next === undefined || /[A-Za-z/!?]/.test(next)) esc(i);
        break;
      case "&":
        if (/^#?\w+;/.test(chars.slice(i + 1, i + 34).join(""))) esc(i);
        else if (next === undefined) esc(i);
        break;
    }
  }
  for (let i = 0; i < chars.length; i += 1) {
    if ((i === 0 && ctx.lineStart) || chars[i - 1] === "\n") escapeLineStart(chars, i, esc);
  }
  return chars.map((c, i) => (escaped[i] ? `\\${c}` : c)).join("");
}

/**
 * True when a run of `*`, `_` or `~` can neither open nor close emphasis: it
 * has whitespace on both sides, or (for `_` only) a word character on both.
 */
function inertDelimiter(c: string, prev: string | undefined, next: string | undefined): boolean {
  if (isSpace(prev) && isSpace(next)) return true;
  return c === "_" && isWord(prev) && isWord(next);
}

/**
 * Escape block syntax at the start of a line (#2260): a paragraph's first line, or
 * the line after a hard break, where `- b` would otherwise become a list item.
 */
function escapeLineStart(chars: string[], from: number, esc: (i: number) => void): void {
  let i = from;
  while (i < chars.length && i - from < 3 && (chars[i] === " " || chars[i] === "\t")) i += 1;
  let end = i;
  while (end < chars.length && chars[end] !== "\n") end += 1;
  const line = chars.slice(i, end).join("");
  if (!line) return;
  const ordered = /^(\d{1,9})[.)](?:[ \t]|$)/.exec(line);
  if (ordered) {
    esc(i + ordered[1].length);
    return;
  }
  if (
    /^(?:#{1,6}(?:[ \t]|$)|>|[-+*](?:[ \t]|$)|`{3}|~{3}|\[)/.test(line) ||
    /^(?:=+|-+)[ \t]*$/.test(line) ||
    /^([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line) ||
    /^[|:-][|: \t-]*$/.test(line)
  ) {
    esc(i);
  }
}

function isSpace(c: string | undefined): boolean {
  return c === "" || (c !== undefined && /\s/u.test(c));
}

function isPunct(c: string | undefined): boolean {
  return c !== undefined && c !== "" && /[\p{P}\p{S}]/u.test(c);
}

/** Neither whitespace nor punctuation: a character a delimiter cannot flank from. */
function isWord(c: string | undefined): boolean {
  return c !== undefined && c !== "" && !isSpace(c) && !isPunct(c);
}

function renderInlineNode(node: AdfNode, depth: number, lineStart: boolean): string {
  switch (node.type) {
    case "hardBreak":
      // Two trailing spaces: a bare newline is a soft break and renders as a space (#2260).
      return "  \n";
    case "mention": {
      const text = attrString(node, "text");
      return text ? escapeText(text, { lineStart }) : "@user";
    }
    case "emoji":
      return escapeText(attrString(node, "text") || attrString(node, "shortName"), { lineStart });
    case "inlineCard": {
      const url = safeUrl(attrString(node, "url"));
      return url ? `<${url}>` : "";
    }
    case "date": {
      const ms = Number(attr(node, "timestamp"));
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "status": {
      // Escaped brackets, so a following `(url)` cannot turn the lozenge into a link.
      const text = attrString(node, "text");
      return text ? `\\[${escapeText(text, { inLink: true })}\\]` : "";
    }
    case "placeholder":
      return "";
    default:
      if (typeof node.text === "string") return escapeText(node.text, { lineStart });
      return renderInline(childrenOf(node), depth + 1, lineStart ? "line" : "unknown");
  }
}
/** Keep http(s) and mailto targets only, with parentheses escaped for Markdown. */
function safeUrl(raw: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
  return url.href.replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/[<>]/g, encodeURIComponent);
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((line) => (line ? pad + line : line))
    .join("\n");
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
