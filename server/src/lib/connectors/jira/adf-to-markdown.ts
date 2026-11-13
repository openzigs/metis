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
      return `${"#".repeat(level)} ${renderInline(children, next)}`;
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
      if (typeof node.text === "string") return escapeText(node.text);
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
}

/**
 * Render a run of inline nodes. Marks are opened and closed across the run
 * rather than per text node (#2260): two adjacent bold nodes become one
 * `**foobar**`, and bold followed by bold-italic nests as `**foo*bar***`
 * instead of fusing into `**foo*****bar***`.
 */
function renderInline(nodes: AdfNode[], depth: number): string {
  if (depth > MAX_DEPTH) return "";
  let out = "";
  const open: OpenMark[] = [];
  // Close the marks above `keep`, moving trailing whitespace outside them: `**a **` does not render.
  const closeTo = (keep: number) => {
    if (open.length <= keep) return;
    // Scan back from the end: an unanchored `/\s*$/` is quadratic in any earlier whitespace run.
    let cut = out.length;
    while (cut > 0 && /\s/.test(out[cut - 1])) cut -= 1;
    const trail = out.slice(cut);
    out = out.slice(0, cut);
    while (open.length > keep) out += closer(open.pop() as OpenMark);
    out += trail;
  };
  for (const item of mergeTextRuns(nodes)) {
    if (!isRun(item)) {
      closeTo(0);
      out += renderInlineNode(item, depth);
      continue;
    }
    let keep = 0;
    while (
      keep < open.length &&
      keep < item.marks.length &&
      sameMark(open[keep], item.marks[keep])
    ) {
      keep += 1;
    }
    closeTo(keep);
    // Markers must hug the text, so edge spaces stay outside any marker opened here.
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(item.text) as RegExpExecArray;
    if (core.length === 0) {
      out += item.text;
      continue;
    }
    out += lead;
    for (const mark of item.marks.slice(keep)) {
      out += opener(mark);
      open.push(mark);
    }
    out += (item.code ? codeSpan(core) : escapeText(core)) + trail;
  }
  closeTo(0);
  return out;
}

/** Fold adjacent text nodes carrying the same marks into one run; other nodes pass through. */
function mergeTextRuns(nodes: AdfNode[]): Array<TextRun | AdfNode> {
  const items: Array<TextRun | AdfNode> = [];
  for (const node of nodes) {
    if (node.type !== "text") {
      items.push(node);
      continue;
    }
    if (typeof node.text !== "string" || node.text.length === 0) continue;
    const run: TextRun = { kind: "run", text: node.text, ...marksOf(node.marks) };
    const prev = items[items.length - 1];
    if (prev && isRun(prev) && sameMarks(prev, run)) prev.text += run.text;
    else items.push(run);
  }
  return items;
}

function isRun(item: TextRun | AdfNode): item is TextRun {
  return (item as TextRun).kind === "run";
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

function codeSpan(core: string): string {
  const longestRun = Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length));
  const ticks = "`".repeat(longestRun + 1);
  const pad = core.startsWith("`") || core.endsWith("`") ? " " : "";
  return `${ticks}${pad}${core}${pad}${ticks}`;
}

/**
 * Escape text so Markdown reads it as the characters it is (#2260): no
 * emphasis, strikethrough, code span, link, image, autolink or raw HTML can
 * form from what was typed into Jira. Pipes are left to the table renderer,
 * the only place they mean anything; `&` only where it would start an entity.
 */
function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]<~]/g, "\\$&").replace(/&(?=#?\w+;)/g, "\\&");
}

function renderInlineNode(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "hardBreak":
      // Two trailing spaces: a bare newline is a soft break and renders as a space (#2260).
      return "  \n";
    case "mention": {
      const text = attrString(node, "text");
      return text ? escapeText(text) : "@user";
    }
    case "emoji":
      return escapeText(attrString(node, "text") || attrString(node, "shortName"));
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
      return text ? `\\[${escapeText(text)}\\]` : "";
    }
    case "placeholder":
      return "";
    default:
      if (typeof node.text === "string") return escapeText(node.text);
      return renderInline(childrenOf(node), depth + 1);
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
