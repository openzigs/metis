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
 * in a Jira description never becomes a clickable Markdown link.
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

/** Render a run of block nodes, grouping stray inline nodes into a paragraph. */
function renderBlocks(nodes: AdfNode[], depth: number, separator = "\n\n"): string {
  const parts: string[] = [];
  let inlineRun: AdfNode[] = [];
  const flush = () => {
    if (inlineRun.length > 0) parts.push(renderInline(inlineRun, depth));
    inlineRun = [];
  };
  for (const node of nodes) {
    if (isInline(node)) {
      inlineRun.push(node);
      continue;
    }
    flush();
    parts.push(renderBlock(node, depth));
  }
  flush();
  return parts.filter((p) => p.trim().length > 0).join(separator);
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
      const label = attrString(node, "panelType");
      const body = renderBlocks(children, next);
      return quote(label ? `**${capitalise(label)}:** ${body}` : body);
    }
    case "expand":
    case "nestedExpand": {
      const title = attrString(node, "title");
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
      if (typeof node.text === "string") return node.text;
      return renderBlocks(children, next);
  }
}

function renderListItem(item: AdfNode, marker: string, depth: number): string {
  const children = childrenOf(item);
  // A list item holds blocks (paragraph, nested list); a task or decision item holds inline nodes.
  const body = renderBlocks(children, depth, "\n");
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
          // Backslashes first, so a cell's own `\` cannot un-escape the `\|` after it.
          .replace(/\\/g, "\\\\")
          .replace(/\|/g, "\\|")
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
  const alt = attrString(node, "alt");
  return alt ? `[attachment: ${alt}]` : "[attachment]";
}

function renderInline(nodes: AdfNode[], depth: number): string {
  if (depth > MAX_DEPTH) return "";
  return nodes.map((n) => renderInlineNode(n, depth)).join("");
}

function renderInlineNode(node: AdfNode, depth: number): string {
  switch (node.type) {
    case "text":
      return typeof node.text === "string" ? applyMarks(node.text, node.marks) : "";
    case "hardBreak":
      return "\n";
    case "mention": {
      const text = attrString(node, "text");
      return text || "@user";
    }
    case "emoji":
      return attrString(node, "text") || attrString(node, "shortName");
    case "inlineCard": {
      const url = safeUrl(attrString(node, "url"));
      return url ? `<${url}>` : "";
    }
    case "date": {
      const ms = Number(attr(node, "timestamp"));
      return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "status": {
      const text = attrString(node, "text");
      return text ? `[${text}]` : "";
    }
    case "placeholder":
      return "";
    default:
      if (typeof node.text === "string") return node.text;
      return renderInline(childrenOf(node), depth + 1);
  }
}

function applyMarks(text: string, marks: unknown): string {
  if (!Array.isArray(marks) || marks.length === 0 || text.length === 0) return text;
  const types = new Map<string, AdfNode>();
  for (const m of marks) {
    if (m && typeof m === "object" && typeof (m as AdfNode).type === "string") {
      types.set((m as AdfNode).type as string, m as AdfNode);
    }
  }
  // Markers must hug the text: `** bold**` does not render, so keep edge spaces outside.
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const [lead, core, trail] = match ? [match[1], match[2], match[3]] : ["", text, ""];
  if (core.length === 0) return text;
  let out = core;
  if (types.has("code")) {
    const longestRun = Math.max(0, ...(core.match(/`+/g) ?? []).map((r) => r.length));
    const ticks = "`".repeat(longestRun + 1);
    const pad = core.startsWith("`") || core.endsWith("`") ? " " : "";
    out = `${ticks}${pad}${core}${pad}${ticks}`;
  } else {
    if (types.has("strike")) out = `~~${out}~~`;
    if (types.has("em")) out = `*${out}*`;
    if (types.has("strong")) out = `**${out}**`;
  }
  const link = types.get("link");
  if (link) {
    const href = safeUrl(attrString(link, "href"));
    if (href) out = `[${out}](${href})`;
  }
  return `${lead}${out}${trail}`;
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
