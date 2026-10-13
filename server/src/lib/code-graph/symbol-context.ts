/**
 * Issue #1072 — what a symbol's search documents know about it beyond its name.
 *
 * Until #1072 the BM25 document was `name + qualifiedName` and the embedding
 * text was a header line plus the first ten body lines. This module holds the
 * bounds of the fields #1072 adds. They were fixed in the pre-registration
 * commit, before any arm was scored, so a measured result could not move them
 * (`docs/decisions/0020-contextual-symbol-documents.md`).
 *
 * Two kinds of field, with different lifetimes:
 *
 *  - OWN-FILE fields (signature, doc comment, receiver, package) depend only on
 *    the file that declares the symbol. They change exactly when that file is
 *    re-parsed.
 *  - CROSS-FILE fields (callers, tables) depend on edges written by OTHER
 *    files. They change when a file that does not declare the symbol changes.
 */

/** Longest signature kept, in characters. A declaration longer than this is a parameter list, not a name. */
export const MAX_SIGNATURE_CHARS = 300;

/**
 * Longest doc comment kept, in characters. About 150 tokens: the summary
 * paragraph of a doc comment. BM25 normalises by document length, so an
 * unbounded comment would tax the symbol that is documented best.
 */
export const MAX_DOC_COMMENT_CHARS = 600;

/** Longest receiver (the type a method is declared on) kept, in characters. */
export const MAX_RECEIVER_CHARS = 120;

/** Longest package name kept, in characters. */
export const MAX_PACKAGE_CHARS = 120;

/**
 * N — the most caller names one symbol's documents carry.
 *
 * Five, because the field is there to say what a symbol is used FOR, and a
 * handful of distinct callers says that; a utility called from two hundred
 * places is described by none of them, and its document would otherwise be
 * two hundred names long and outrank nothing. Chosen before measuring and not
 * swept: a sweep over N on a 127-query corpus would be fitted to it.
 *
 * Which five is deterministic and independent of call counts: distinct caller
 * names in ascending code-unit order. Ordering by call frequency would reorder
 * the list — and so change the document — whenever an unrelated file gained a
 * call site.
 */
export const MAX_CONTEXT_CALLERS = 5;

/** The most table names one symbol's documents carry (distinct, ascending code-unit order). */
export const MAX_CONTEXT_TABLES = 8;

/** Longest single caller or table name kept, in characters. */
export const MAX_CONTEXT_NAME_CHARS = 80;

/** Most lines of a symbol's body a fused hit's snippet carries. */
export const MAX_SNIPPET_LINES = 10;

/** Most characters a fused hit's snippet carries. */
export const MAX_SNIPPET_CHARS = 800;

// ---- Neutralising repository text ------------------------------------------

/** Zero-width space, joiners, word joiner, BOM, Mongolian vowel separator. */
function isZeroWidth(code: number): boolean {
  return (
    (code >= 0x200b && code <= 0x200d) || code === 0x2060 || code === 0xfeff || code === 0x180e
  );
}

/** C0 and C1 controls, DELETE, and the Unicode line and paragraph separators. */
function isLineOrControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029;
}

/** Bidirectional embedding, override and isolate controls: they reorder what a reader sees. */
function isBidiControl(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * `text` on ONE line: every control or line separator becomes a space, every
 * zero-width or bidirectional control is dropped, runs of white space collapse
 * and the ends are trimmed.
 *
 * A signature or a doc comment is repository text, and it ends up in a
 * document and in a prompt that quotes a fused hit. The prompt blocks that
 * quote one are line-structured (`[n] name (kind) — path:lines`, a `##`
 * heading), so text that cannot start a line of its own cannot forge an entry
 * or a heading. The same rule as `printable` in `docs-gen/canonical-facts.ts`.
 */
export function oneLine(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (isZeroWidth(code) || isBidiControl(code)) continue;
    out += isLineOrControl(code) ? " " : text[i];
  }
  return out.replace(/\s+/g, " ").trim();
}

/** `text` cut to `max` UTF-16 units without splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  const cut = last >= 0xd800 && last <= 0xdbff ? max - 1 : max;
  return text.slice(0, cut);
}

/** How many times a field's bound is read before the one-line pass: a minified line can be megabytes. */
const FIELD_SCAN_FACTOR = 8;

/** One stored field: on one line, bounded, or null when nothing is left. */
export function boundedField(text: string, max: number): string | null {
  const scan = max * FIELD_SCAN_FACTOR;
  const out = clip(oneLine(text.length > scan ? text.slice(0, scan) : text), max).trim();
  return out.length > 0 ? out : null;
}

// ---- Own-file fields --------------------------------------------------------

/** The fields that depend only on the file that declares the symbol. */
export interface OwnFileContext {
  signature: string | null;
  docComment: string | null;
  receiver: string | null;
  package: string | null;
}

/** What {@link extractOwnFileContext} needs to know about a parsed symbol. */
export interface ContextSourceSymbol {
  kind: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
}

/** Most lines a declaration is followed over before the first is taken as the signature. */
const SIGNATURE_SCAN_LINES = 8;
/** Most lines a doc comment is followed over. */
const DOC_SCAN_LINES = 40;
/** Most annotation or decorator lines skipped between a doc comment and its declaration. */
const ANNOTATION_SCAN_LINES = 5;
/** Most lines read from the top of a file when looking for its package clause. */
const PACKAGE_SCAN_LINES = 200;
/** Most characters of one source line any scan here reads. */
const LINE_SCAN_CHARS = 2000;

/** Languages that declare their package in the file. */
const PACKAGE_CLAUSE_LANGUAGES: ReadonlySet<string> = new Set(["go", "java", "kt", "scala"]);
/** Languages whose line comment is `#` and whose doc comment is a docstring. */
const HASH_COMMENT_LANGUAGES: ReadonlySet<string> = new Set(["py"]);

const PACKAGE_CLAUSE = /^\s*package\s+([A-Za-z_][\w.]{0,200})/;
/** Comment lines that address a tool, not a reader. */
const DIRECTIVE =
  /^(?:eslint-|nosemgrep|@ts-|prettier-|istanbul |c8 |noinspection|go:|nolint|type: ignore|pylint:|noqa)/;

function lineAt(lines: readonly string[], index: number): string {
  const line = lines[index] ?? "";
  return line.length > LINE_SCAN_CHARS ? line.slice(0, LINE_SCAN_CHARS) : line;
}

/**
 * The package a file belongs to: its `package` clause where the language has
 * one, otherwise the name of the directory it is in (which is what a Go
 * package is by convention, and the nearest thing a TypeScript or Python
 * module has). Null for a file at the repository root with no clause.
 */
export function packageOfFile(
  filePath: string,
  language: string,
  sourceLines: readonly string[],
): string | null {
  if (PACKAGE_CLAUSE_LANGUAGES.has(language)) {
    const limit = Math.min(sourceLines.length, PACKAGE_SCAN_LINES);
    for (let i = 0; i < limit; i += 1) {
      const m = PACKAGE_CLAUSE.exec(lineAt(sourceLines, i));
      if (m) return boundedField(m[1], MAX_PACKAGE_CHARS);
    }
  }
  const parts = filePath.split("/");
  return parts.length >= 2 ? boundedField(parts[parts.length - 2], MAX_PACKAGE_CHARS) : null;
}

/**
 * The declaration: from its first line to where the body opens.
 *
 * The body opens at the first `{` outside parentheses and brackets, or, in
 * Python, at the `:` that ends a line outside them. A declaration that opens
 * no body within {@link SIGNATURE_SCAN_LINES} lines is its first line.
 *
 * The scan ends with the symbol's span unless a bracket is still open there:
 * a parameter list that has not closed is still the declaration, whatever the
 * parser recorded as the symbol's last line (the regex parsers end a
 * multi-line declaration on its first line).
 */
function signatureOf(
  sym: ContextSourceSymbol,
  language: string,
  sourceLines: readonly string[],
): string | null {
  const first = sym.startLine - 1;
  if (first < 0 || first >= sourceLines.length) return null;
  const last = Math.min(first + SIGNATURE_SCAN_LINES, sourceLines.length);
  const python = HASH_COMMENT_LANGUAGES.has(language);
  let depth = 0;
  let text = "";
  for (let i = first; i < last; i += 1) {
    const line = lineAt(sourceLines, i);
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
      else if (depth === 0 && !python && ch === "{") {
        return boundedField(text + line.slice(0, c), MAX_SIGNATURE_CHARS);
      }
    }
    text += `${line} `;
    if (python && depth === 0 && line.trimEnd().endsWith(":")) {
      return boundedField(text, MAX_SIGNATURE_CHARS);
    }
    if (i + 1 >= sym.endLine && depth === 0) break;
  }
  return boundedField(lineAt(sourceLines, first), MAX_SIGNATURE_CHARS);
}

/** One comment line without its marker; null when it is empty or a tool directive. */
function commentBody(line: string): string | null {
  const body = line
    .trim()
    .replace(/^\/\*+/, "")
    .replace(/\*+\/$/, "")
    .trim()
    .replace(/^(?:\/\/+|\*+|#+)/, "")
    .trim();
  return body.length === 0 || DIRECTIVE.test(body) ? null : body;
}

/** The comment block that ends on line index `end`, or null when that line ends none. */
function commentEndingAt(
  end: number,
  language: string,
  sourceLines: readonly string[],
): string | null {
  const lastLine = lineAt(sourceLines, end).trim();
  const floor = Math.max(0, end - DOC_SCAN_LINES + 1);
  const bodies: string[] = [];
  // Read off the whole line, not the scanned prefix: a long one-line comment
  // still closes at its end.
  if ((sourceLines[end] ?? "").trimEnd().endsWith("*/")) {
    for (let i = end; i >= floor; i -= 1) {
      const line = lineAt(sourceLines, i);
      const body = commentBody(line);
      if (body) bodies.unshift(body);
      if (line.includes("/*")) return bodies.join(" ");
    }
    // The opener is further up than a doc comment is followed: not one.
    return null;
  }
  const hash = HASH_COMMENT_LANGUAGES.has(language);
  const isLineComment = (line: string): boolean =>
    hash ? line.startsWith("#") && !line.startsWith("#!") : line.startsWith("//");
  if (!isLineComment(lastLine)) return null;
  for (let i = end; i >= floor; i -= 1) {
    const line = lineAt(sourceLines, i).trim();
    if (!isLineComment(line)) break;
    const body = commentBody(line);
    if (body) bodies.unshift(body);
  }
  return bodies.join(" ");
}

const DOCSTRING_OPENER = /^[rRuUbB]{0,2}("""|''')/;

/** A Python docstring: the string literal that is the first statement of the body. */
function pythonDocstring(sym: ContextSourceSymbol, sourceLines: readonly string[]): string | null {
  const first = sym.startLine - 1;
  const last = Math.min(sym.endLine, sourceLines.length);
  // The body starts after the line that ends the `def` / `class` header.
  let i = first;
  const headerEnd = Math.min(last, first + SIGNATURE_SCAN_LINES);
  while (i < headerEnd && !lineAt(sourceLines, i).trimEnd().endsWith(":")) i += 1;
  i += 1;
  while (i < last && lineAt(sourceLines, i).trim() === "") i += 1;
  if (i >= last) return null;
  const opener = DOCSTRING_OPENER.exec(lineAt(sourceLines, i).trim());
  if (!opener) return null;
  const quote = opener[1];
  const bodies: string[] = [];
  const stop = Math.min(last, i + DOC_SCAN_LINES);
  for (let j = i; j < stop; j += 1) {
    let line = lineAt(sourceLines, j).trim();
    if (j === i) line = line.slice(opener[0].length);
    const close = line.indexOf(quote);
    if (close !== -1) {
      bodies.push(line.slice(0, close));
      break;
    }
    bodies.push(line);
  }
  return bodies.join(" ");
}

/** The doc comment directly above the declaration, or a Python docstring inside it. */
function docCommentOf(
  sym: ContextSourceSymbol,
  language: string,
  sourceLines: readonly string[],
): string | null {
  if (HASH_COMMENT_LANGUAGES.has(language)) {
    const docstring = pythonDocstring(sym, sourceLines);
    const kept = docstring === null ? null : boundedField(docstring, MAX_DOC_COMMENT_CHARS);
    if (kept) return kept;
  }
  // Decorators and annotations sit between a doc comment and what it documents.
  let above = sym.startLine - 2;
  for (let skipped = 0; above >= 0 && skipped < ANNOTATION_SCAN_LINES; skipped += 1) {
    if (!lineAt(sourceLines, above).trim().startsWith("@")) break;
    above -= 1;
  }
  if (above < 0) return null;
  const comment = commentEndingAt(above, language, sourceLines);
  return comment === null ? null : boundedField(comment, MAX_DOC_COMMENT_CHARS);
}

/**
 * The type a method is declared on: the segment of the qualified name before
 * the method's own (`<file>::<Type>::<name>`). A Go method is a `function`
 * symbol named that way since #1071, so Go is read by shape, not by kind.
 */
function receiverOf(sym: ContextSourceSymbol, filePath: string, language: string): string | null {
  if (sym.kind !== "method" && language !== "go") return null;
  const prefix = `${filePath}::`;
  if (!sym.qualifiedName.startsWith(prefix)) return null;
  const parts = sym.qualifiedName.slice(prefix.length).split("::");
  return parts.length >= 2 ? boundedField(parts[parts.length - 2], MAX_RECEIVER_CHARS) : null;
}

/** The own-file fields of one parsed symbol. `file.package` is {@link packageOfFile} of its file. */
export function extractOwnFileContext(
  sym: ContextSourceSymbol,
  file: { filePath: string; language: string; package: string | null },
  sourceLines: readonly string[],
): OwnFileContext {
  return {
    signature: signatureOf(sym, file.language, sourceLines),
    docComment: docCommentOf(sym, file.language, sourceLines),
    receiver: receiverOf(sym, file.filePath, file.language),
    package: file.package,
  };
}

// ---- Cross-file fields ------------------------------------------------------

/** The fields that depend on edges written by other files. */
export interface CrossFileContext {
  callers: string[];
  tables: string[];
}

export interface ContextSymbolRef {
  id: string;
  name: string;
  kind: string;
  qualifiedName: string;
}

export interface ContextEdgeRef {
  kind: string;
  fromSymbolId: string;
  toSymbolId: string | null;
}

/** Ascending UTF-16 code-unit order — the same on every platform and locale. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The first `max` distinct names in code-unit order, each bounded and on one line. */
function firstNames(names: Iterable<string>, max: number): string[] {
  const distinct = new Set<string>();
  for (const raw of names) {
    const name = boundedField(raw, MAX_CONTEXT_NAME_CHARS);
    if (name) distinct.add(name);
  }
  return [...distinct].sort(byCodeUnit).slice(0, max);
}

/** The table a `reads` / `writes` edge lands on: the table itself, or a column's table. */
function tableNameOf(target: ContextSymbolRef): string | null {
  if (target.kind === "table") return target.name;
  if (target.kind !== "column") return null;
  const dot = target.qualifiedName.lastIndexOf(".");
  return dot > 0 ? target.qualifiedName.slice(0, dot) : null;
}

/**
 * Callers and tables for every symbol that has any, from the project's edges.
 *
 * - **Callers:** the names of the symbols with a resolved `calls` edge to this
 *   one. A symbol calling itself and a file's `module` symbol are not callers.
 * - **Tables:** the tables this symbol has a `reads` or `writes` edge to.
 *
 * Both lists are distinct names in ascending code-unit order, cut to
 * {@link MAX_CONTEXT_CALLERS} and {@link MAX_CONTEXT_TABLES}. The order does not
 * depend on how often a caller calls or on the order the edges arrive in, so
 * the same graph always gives the same lists.
 *
 * A symbol with neither is absent from the map.
 */
export function deriveCrossFileContext(
  symbols: Iterable<ContextSymbolRef>,
  edges: Iterable<ContextEdgeRef>,
): Map<string, CrossFileContext> {
  const byId = new Map<string, ContextSymbolRef>();
  for (const s of symbols) byId.set(s.id, s);

  const callers = new Map<string, string[]>();
  const tables = new Map<string, string[]>();
  const push = (into: Map<string, string[]>, key: string, value: string): void => {
    const list = into.get(key);
    if (list) list.push(value);
    else into.set(key, [value]);
  };

  for (const edge of edges) {
    if (edge.toSymbolId === null || edge.toSymbolId === edge.fromSymbolId) continue;
    const from = byId.get(edge.fromSymbolId);
    const to = byId.get(edge.toSymbolId);
    if (!from || !to) continue;
    if (edge.kind === "calls") {
      if (from.kind !== "module") push(callers, to.id, from.name);
    } else if (edge.kind === "reads" || edge.kind === "writes") {
      const table = tableNameOf(to);
      if (table) push(tables, from.id, table);
    }
  }

  const out = new Map<string, CrossFileContext>();
  for (const id of new Set([...callers.keys(), ...tables.keys()])) {
    const context: CrossFileContext = {
      callers: firstNames(callers.get(id) ?? [], MAX_CONTEXT_CALLERS),
      tables: firstNames(tables.get(id) ?? [], MAX_CONTEXT_TABLES),
    };
    if (context.callers.length > 0 || context.tables.length > 0) out.set(id, context);
  }
  return out;
}

// ---- Documents --------------------------------------------------------------

/** What a document builder reads; every context field is optional. */
export interface DocumentSymbol {
  name: string;
  qualifiedName: string;
  signature?: string | null;
  docstring?: string | null;
  receiver?: string | null;
  package?: string | null;
  callers?: readonly string[];
  tables?: readonly string[];
}

/**
 * The BM25 document of one symbol.
 *
 * `own` is name, qualified name, receiver, package, signature and doc comment;
 * `full` appends the caller names and the table names. The name stays first
 * and nothing is repeated to weight it.
 */
export function contextualDocumentText(sym: DocumentSymbol, fields: "own" | "full"): string {
  const parts = [sym.name, sym.qualifiedName];
  if (sym.receiver) parts.push(sym.receiver);
  if (sym.package) parts.push(sym.package);
  if (sym.signature) parts.push(sym.signature);
  if (sym.docstring) parts.push(sym.docstring);
  if (fields === "full") {
    if (sym.callers) parts.push(...sym.callers);
    if (sym.tables) parts.push(...sym.tables);
  }
  return parts.join(" ");
}

/**
 * The labelled lines the embedding text gains: `receiver:`, `package:`, `doc:`,
 * then `tables:` and `callers:` when `cross` is given. Empty string when there
 * is nothing to say. Every value is already one line, so each line here is one
 * field.
 *
 * The signature has no line: the body lines that follow already start with the
 * declaration.
 */
export function contextLines(
  own: Pick<OwnFileContext, "receiver" | "package" | "docComment">,
  cross?: CrossFileContext,
): string {
  const lines: string[] = [];
  if (own.receiver) lines.push(`receiver: ${own.receiver}`);
  if (own.package) lines.push(`package: ${own.package}`);
  if (own.docComment) lines.push(`doc: ${own.docComment}`);
  if (cross && cross.tables.length > 0) lines.push(`tables: ${cross.tables.join(", ")}`);
  if (cross && cross.callers.length > 0) lines.push(`callers: ${cross.callers.join(", ")}`);
  return lines.join("\n");
}

/**
 * The text that is embedded: `baseText` with `context` placed after its header
 * line and before its body.
 *
 * `baseText` is `{kind} {name} in {filePath}` and the body lines, as ingest has
 * always stored it. Keeping the two apart is what lets the context be rebuilt
 * when another file changes without the source of this one: the body is not
 * stored anywhere else.
 */
export function composeEmbeddingText(baseText: string, context: string | null | undefined): string {
  if (!context) return baseText;
  const headerEnd = baseText.indexOf("\n");
  if (headerEnd === -1) return `${baseText}\n${context}`;
  return `${baseText.slice(0, headerEnd)}\n${context}${baseText.slice(headerEnd)}`;
}

/** How many times the snippet bound is read from a stored text before it is split into lines. */
const SNIPPET_SCAN_FACTOR = 4;

/** A line that the blocks quoting a hit would read as their own structure. */
const STRUCTURE_LINE = /^(?:#{1,6}\s|\[\d+\]\s|```|~~~)/;

/** One snippet line: unprintable characters out, indentation kept, structure defused. */
function snippetLine(line: string): string {
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i);
    if (isZeroWidth(code) || isBidiControl(code)) continue;
    // A tab is indentation; every other control would end or corrupt the line.
    out += code !== 0x09 && isLineOrControl(code) ? " " : line[i];
  }
  out = out.trimEnd();
  return STRUCTURE_LINE.test(out) ? `  ${out}` : out;
}

/**
 * The bounded body snippet a fused hit carries, cut from a stored `baseText`:
 * the lines after the header, at most {@link MAX_SNIPPET_LINES} of them and
 * {@link MAX_SNIPPET_CHARS} characters.
 *
 * It stays multi-line, because it is code. Each line has its control,
 * zero-width and bidirectional characters removed, and a line that would read
 * as structure in the blocks that quote hits — a markdown heading, a fence, or
 * an entry head `[n] ` — is indented, so it is code inside the entry and not
 * the start of a new one.
 */
export function bodySnippet(baseText: string): string | undefined {
  const headerEnd = baseText.indexOf("\n");
  if (headerEnd === -1) return undefined;
  const lines = baseText
    .slice(headerEnd + 1, headerEnd + 1 + MAX_SNIPPET_CHARS * SNIPPET_SCAN_FACTOR)
    .split("\n")
    .slice(0, MAX_SNIPPET_LINES)
    .map(snippetLine);
  const snippet = clip(lines.join("\n"), MAX_SNIPPET_CHARS).trimEnd();
  return snippet.trim().length > 0 ? snippet : undefined;
}
