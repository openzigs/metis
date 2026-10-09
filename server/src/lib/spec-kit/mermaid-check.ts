/**
 * #944 item 5 — find flowchart nodes a generated plan links to but never
 * declares.
 *
 * Mermaid accepts `R --> B` with `B` defined nowhere and draws a box labelled
 * `B`, so a plan whose diagram points at a component it never names renders
 * without error and reads as if the node were real. When a diagram labels its
 * nodes (`R["UI route"]`), an edge endpoint that is never labelled anywhere in
 * that diagram is the tell. A diagram that labels nothing (`A --> B`) is the
 * bare-id style, not a defect, and is left alone.
 *
 * Only `graph` / `flowchart` blocks are read: sequence and ER diagrams declare
 * their participants differently. A hand-written scanner, linear in the input
 * and with no regex over the untrusted body (#1253/#1260 measured quadratic
 * backtracking on model output).
 */

const FENCE_OPEN = "```mermaid";
const FENCE_CLOSE = "```";

/** Lines that carry no edge to read. `subgraph` is handled separately. */
const SKIPPED_KEYWORDS = new Set([
  "end",
  "classDef",
  "class",
  "style",
  "linkStyle",
  "click",
  "direction",
]);

const SHAPE_OPEN = new Set(["[", "(", "{"]);
const BRACKET_CLOSE: Record<string, string> = { "[": "]", "(": ")", "{": "}" };
const ARROW_CHARS = new Set(["-", "=", ".", "<", ">"]);
/** A `-- text -->` link opens with one of these and closes with an arrow. */
const TEXT_LINK_OPENERS = new Set(["--", "==", "-."]);
const TEXT_LINK_CLOSERS = ["-->", "---", "==>", "===", ".->", "-.-"];

const isIdChar = (c: string | undefined): boolean => c !== undefined && /\w/.test(c);

/** The Mermaid block bodies in a Markdown document, in order. */
function mermaidBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const open = markdown.indexOf(FENCE_OPEN, from);
    if (open < 0) return blocks;
    const bodyStart = markdown.indexOf("\n", open);
    if (bodyStart < 0) return blocks;
    const close = markdown.indexOf(FENCE_CLOSE, bodyStart + 1);
    blocks.push(markdown.slice(bodyStart + 1, close < 0 ? markdown.length : close));
    if (close < 0) return blocks;
    from = close + FENCE_CLOSE.length;
  }
}

/** Index just past a bracketed shape starting at `i`, skipping quoted text and nesting. */
function skipShape(line: string, i: number): number {
  const stack: string[] = [];
  for (let j = i; j < line.length; j++) {
    const c = line[j];
    if (c === '"') {
      const end = line.indexOf('"', j + 1);
      if (end < 0) return line.length;
      j = end;
    } else if (SHAPE_OPEN.has(c)) {
      stack.push(BRACKET_CLOSE[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return j + 1;
    }
  }
  return line.length;
}

/** Index just past the arrow that closes a `-- text -->` link, from `i`. */
function skipTextLink(line: string, i: number): number {
  let best = -1;
  let len = 0;
  for (const closer of TEXT_LINK_CLOSERS) {
    const at = line.indexOf(closer, i);
    if (at >= 0 && (best < 0 || at < best)) {
      best = at;
      len = closer.length;
    }
  }
  if (best < 0) return line.length;
  let j = best + len;
  while (j < line.length && ARROW_CHARS.has(line[j])) j++;
  return j;
}

/** Record the ids one flowchart line declares (with a shape) and references (bare). */
function scanLine(line: string, declared: Set<string>, referenced: string[]): void {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (isIdChar(c)) {
      const start = i;
      while (isIdChar(line[i])) i++;
      const id = line.slice(start, i);
      if (SHAPE_OPEN.has(line[i])) {
        declared.add(id);
        i = skipShape(line, i);
      } else {
        referenced.push(id);
      }
      if (line.startsWith(":::", i)) {
        i += 3;
        while (isIdChar(line[i])) i++;
      }
    } else if (c === '"') {
      const end = line.indexOf('"', i + 1);
      i = end < 0 ? line.length : end + 1;
    } else if (c === "|") {
      const end = line.indexOf("|", i + 1);
      i = end < 0 ? line.length : end + 1;
    } else if (ARROW_CHARS.has(c)) {
      const start = i;
      while (ARROW_CHARS.has(line[i])) i++;
      const run = line.slice(start, i);
      // `--o B` / `--x B`: a circle or cross arrowhead, not a node called `o`.
      if ((line[i] === "o" || line[i] === "x") && !isIdChar(line[i + 1])) i++;
      else if (TEXT_LINK_OPENERS.has(run) && line[i] === " ") i = skipTextLink(line, i);
    } else {
      i++;
    }
  }
}

/** Undeclared endpoints of ONE flowchart body, in first-seen order. */
function undeclaredIn(body: string): string[] {
  const lines = body.split("\n");
  const header = lines.findIndex((l) => l.trim().length > 0);
  if (header < 0) return [];
  const kind = lines[header].trim().split(/\s/)[0];
  if (kind !== "graph" && kind !== "flowchart") return [];

  const declared = new Set<string>();
  const referenced: string[] = [];
  for (const raw of lines.slice(header + 1)) {
    const comment = raw.indexOf("%%");
    const line = (comment < 0 ? raw : raw.slice(0, comment)).trim();
    if (line.length === 0) continue;
    const word = line.split(/\s/)[0];
    if (word === "subgraph") {
      const name = line.slice(word.length).trim();
      let end = 0;
      while (isIdChar(name[end])) end++;
      if (end > 0) declared.add(name.slice(0, end));
      continue;
    }
    if (SKIPPED_KEYWORDS.has(word)) continue;
    scanLine(line, declared, referenced);
  }
  if (declared.size === 0) return [];
  return [...new Set(referenced.filter((id) => !declared.has(id)))];
}

/**
 * Flowchart node ids that some edge links to but no line of the same diagram
 * declares with a label, across every Mermaid block in `markdown`, each once.
 */
export function findUndeclaredMermaidNodes(markdown: string): string[] {
  const out: string[] = [];
  for (const block of mermaidBlocks(markdown)) {
    for (const id of undeclaredIn(block)) if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The note a step's success message carries, or `""` when every node is declared. */
export function describeUndeclaredMermaidNodes(artifact: string, nodes: readonly string[]): string {
  if (nodes.length === 0) return "";
  const n = nodes.length;
  return ` \`${artifact}\`'s Mermaid diagram links to ${n} node${n === 1 ? "" : "s"} it never declares: ${nodes.map((id) => `\`${id}\``).join(", ")}.`;
}
