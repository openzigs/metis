/**
 * MyBatis schema extractor — Epic #168 (#170).
 *
 * Infers the database tables/columns a MyBatis mapper touches, from two
 * sources:
 *   1. XML mappers (`<mapper namespace>`, `<select|insert|update|delete>`,
 *      `<sql>`/`<include>` fragments), and
 *   2. annotation mappers (`@Select`/`@Insert`/`@Update`/`@Delete` on Java
 *      interface methods).
 *
 * The SQL inside each statement is parsed heuristically (no live DB, no JDBC):
 * MyBatis parameter placeholders `#{...}` / `${...}` are stripped, dynamic tags
 * are flattened, and table/column identifiers are recovered from the
 * `FROM`/`JOIN`/`INTO`/`UPDATE`/`SET`/`INSERT (...)` positions.
 *
 * Output is a list of {@link MyBatisStatement}s, each linking a statement
 * symbol → the tables/columns it reads or writes. {@link persistMyBatisFile}
 * funnels that through a {@link SchemaGraphWriter} with `source = "mybatis"`.
 */
import type { SchemaEdgeKind } from "@metis/shared";
import {
  dynamicPlaceholderName,
  unresolvedRefMetadata,
  type SchemaGraphWriter,
} from "./schema-graph.js";

/** How a statement touches a table: read (SELECT), write (UPDATE/DELETE), persist (INSERT). */
export type SqlAccess = "read" | "write" | "persist";

const ACCESS_EDGE_KIND: Record<SqlAccess, SchemaEdgeKind> = {
  read: "reads",
  write: "writes",
  persist: "persists-to",
};

/** A table (and the columns referenced on it) touched by one statement. */
export interface SchemaTableRef {
  /** The table name (concrete), or the raw `${...}` placeholder text when {@link unresolved}. */
  table: string;
  /** Optional schema qualifier captured from `schema.table`. Never set when {@link unresolved}. */
  schema?: string;
  columns: string[];
  access: SqlAccess;
  /**
   * Set when this ref came from a MyBatis `${...}` raw-substitution table name
   * rather than a literal identifier (#886) — `${}` is frequently used for
   * table/column NAMES and is not resolvable by parsing alone. `table` and
   * {@link placeholder} both hold the raw placeholder expression text in this
   * case (e.g. `tableName` for `${tableName}`); `#{...}` bind params never set
   * this (they're always neutralized to `?` and never reach identifier
   * position).
   */
  unresolved?: boolean;
  /** The raw `${...}` placeholder expression text; only set when {@link unresolved}. */
  placeholder?: string;
}

/** One MyBatis statement and the schema it touches. */
export interface MyBatisStatement {
  statementId: string;
  namespace: string | null;
  /** `<namespace>.<statementId>` when a namespace is known, else `<statementId>`. */
  qualifiedName: string;
  sqlKind: "select" | "insert" | "update" | "delete";
  line: number;
  refs: SchemaTableRef[];
}

// ---- SQL heuristics --------------------------------------------------------

/**
 * Neutralize MyBatis `#{...}` bind params to `?` — they are always safe,
 * driver-bound parameters and can NEVER be a table/column name. `${...}` raw
 * string substitution is deliberately left untouched here (#886): it is
 * frequently used for table/column NAMES (`FROM ${tableName}`), so it must
 * survive into {@link extractSqlRefs}'s table/column-position matching rather
 * than being collapsed to an indistinguishable `?` like a bind param.
 */
export function stripMyBatisPlaceholders(sql: string): string {
  return sql.replace(/#\{[^}]*\}/g, "?");
}

/** Matches a lone `${...}` raw-substitution placeholder occupying an entire
 * captured identifier position (e.g. the whole `FROM` target). */
const DYNAMIC_PLACEHOLDER_RE = /^\$\{\s*([^}]*?)\s*\}$/;

/** Flatten dynamic-SQL XML tags (`<if>`, `<where>`, `<foreach>`, …) to their text. */
function stripXmlTags(xml: string): string {
  return xml.replace(/<\/?[^>]+>/g, " ");
}

function cleanIdentifier(raw: string): { schema?: string; name: string } | null {
  let s = raw.trim().replace(/[`"[\]]/g, "");
  if (!s) return null;
  // Drop a trailing alias: "users u" / "users AS u".
  s = s.split(/\s+(?:as\s+)?/i)[0];
  if (!s || s === "?" || /[(),]/.test(s)) return null;
  if (s.includes(".")) {
    const [schema, name] = s.split(".");
    if (!name) return null;
    return { schema: schema.toLowerCase(), name: name.toLowerCase() };
  }
  return { name: s.toLowerCase() };
}

/** A captured table-position match: either a concrete identifier or a `${...}`
 * raw-substitution placeholder (#886) — the latter can't be resolved by
 * parsing alone and is surfaced as an unresolved ref rather than dropped or
 * turned into a bogus concrete table. */
type TablePositionMatch =
  | { kind: "concrete"; schema?: string; name: string }
  | { kind: "unresolved"; placeholder: string };

function parseTablePosition(raw: string): TablePositionMatch | null {
  const dyn = DYNAMIC_PLACEHOLDER_RE.exec(raw.trim());
  if (dyn) {
    const placeholder = dyn[1].trim();
    // A bare `${}` carries no name to report — drop it rather than emit a
    // nameless unresolved ref.
    return placeholder ? { kind: "unresolved", placeholder } : null;
  }
  const ident = cleanIdentifier(raw);
  return ident ? { kind: "concrete", ...ident } : null;
}

function splitColumns(list: string): string[] {
  return list
    .split(",")
    .map((c) => c.trim())
    .map((c) => {
      // Strip aliases ("u.email AS mail" → "u.email") and table qualifiers.
      const noAlias = c.split(/\s+(?:as\s+)?/i)[0];
      const bare = noAlias.includes(".") ? noAlias.split(".").pop()! : noAlias;
      return bare
        .replace(/[`"[\]]/g, "")
        .trim()
        .toLowerCase();
    })
    .filter((c) => c.length > 0 && c !== "*" && !/[()?]/.test(c) && !c.includes("${"));
}

/**
 * Recover the tables/columns a single SQL statement touches. Best-effort and
 * conservative — unrecognised constructs are simply skipped.
 */
export function extractSqlRefs(
  rawSql: string,
  sqlKind: MyBatisStatement["sqlKind"],
): SchemaTableRef[] {
  const sql = stripMyBatisPlaceholders(stripXmlTags(rawSql)).replace(/\s+/g, " ").trim();
  if (!sql) return [];

  const tableMap = new Map<string, SchemaTableRef>();
  const access: SqlAccess =
    sqlKind === "select" ? "read" : sqlKind === "insert" ? "persist" : "write";

  const upsert = (ref: { schema?: string; name: string }): SchemaTableRef => {
    const key = ref.schema ? `${ref.schema}.${ref.name}` : ref.name;
    let existing = tableMap.get(key);
    if (!existing) {
      existing = { table: ref.name, schema: ref.schema, columns: [], access };
      tableMap.set(key, existing);
    }
    return existing;
  };

  // Dedupes repeated occurrences of the same `${...}` placeholder within one
  // statement (e.g. `${tableName} a JOIN ${tableName} b`) the same way
  // `upsert` dedupes concrete tables.
  const upsertUnresolved = (placeholder: string): SchemaTableRef => {
    const key = `\${${placeholder.toLowerCase()}}`;
    let existing = tableMap.get(key);
    if (!existing) {
      existing = { table: placeholder, columns: [], access, unresolved: true, placeholder };
      tableMap.set(key, existing);
    }
    return existing;
  };

  // FROM / JOIN / INTO / UPDATE → table positions. The identifier alternative
  // matches a `${...}` raw-substitution placeholder too (#886) — MyBatis's
  // literal-substitution syntax is frequently used for table names and is not
  // resolvable by parsing alone, so it must be captured as an unresolved ref
  // rather than silently dropped (the plain identifier class below doesn't
  // include `$`/`{`/`}`).
  const tableRe = /\b(?:from|join|into|update)\s+(\$\{[^}]*\}|[A-Za-z0-9_."`[\]]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(sql)) !== null) {
    const parsed = parseTablePosition(m[1]);
    if (!parsed) continue;
    if (parsed.kind === "unresolved") upsertUnresolved(parsed.placeholder);
    else upsert(parsed);
  }

  // Primary table for column attribution (first table seen).
  const primary = tableMap.values().next().value as SchemaTableRef | undefined;

  if (sqlKind === "insert") {
    const cols = /\binsert\s+into\s+[A-Za-z0-9_."`[\]]+\s*\(([^)]*)\)/i.exec(sql);
    if (cols && primary) primary.columns.push(...splitColumns(cols[1]));
  } else if (sqlKind === "update") {
    const set = /\bset\s+(.+?)(?:\bwhere\b|$)/i.exec(sql);
    if (set && primary) {
      const assigned = set[1]
        .split(",")
        .map((a) => a.split("=")[0])
        .join(",");
      primary.columns.push(...splitColumns(assigned));
    }
  } else if (sqlKind === "select") {
    const sel = /\bselect\s+(.+?)\s+from\b/i.exec(sql);
    if (sel && primary && !/\*/.test(sel[1])) {
      primary.columns.push(...splitColumns(sel[1]));
    }
  }

  for (const ref of tableMap.values()) {
    ref.columns = [...new Set(ref.columns)];
  }
  return [...tableMap.values()];
}

// ---- <include refid> fragment resolution -----------------------------------

/**
 * Inline every `<include refid="...">` in `body` from its `<sql id="...">`
 * definition in `fragments`, recursively (a fragment may itself `<include>`
 * another fragment). `seen` guards against a self- or mutually-referential
 * cycle: a re-entrant refid is dropped (replaced with `""`) rather than
 * recursed into again, so malformed mappers can't blow the stack.
 *
 * Exported standalone (rather than kept as a closure inside
 * {@link parseMyBatisXml}) so the nested-include / missing-refid / cycle
 * edge cases can be unit-tested directly.
 */
export function expandIncludeRefs(
  body: string,
  fragments: Map<string, string>,
  seen: Set<string> = new Set(),
): string {
  return body.replace(
    /<include\b[^>]*\brefid\s*=\s*["']([^"']+)["'][^>]*\/?>/gi,
    (_all, refid: string) => {
      if (seen.has(refid)) return "";
      const frag = fragments.get(refid);
      if (frag === undefined) return "";
      const next = new Set(seen);
      next.add(refid);
      return expandIncludeRefs(frag, fragments, next);
    },
  );
}

// ---- Dynamic-tag branch expansion (UNION, never evaluate OGNL test=) ------

/** Dynamic tags whose bodies/branches are walked by {@link expandVariants}. */
const DYNAMIC_TAG_RE = /<(if|choose|where|set|trim|foreach|bind)\b([^>]*?)(\/)?>/i;

/** Cap combinatorial growth from multiple/nested `<choose>` blocks. */
const MAX_VARIANTS = 64;

/** Matches any `name="value"`/`name='value'` XML attribute; the captured name is
 * compared against the target in JS rather than building a per-name regex
 * (avoids `new RegExp()` with an interpolated pattern — ReDoS audit). */
const ATTR_RE = /([\w-]+)\s*=\s*["']([^"']*)["']/gi;

function readAttr(attrs: string, name: string): string | undefined {
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(attrs)) !== null) {
    if (m[1].toLowerCase() === name.toLowerCase()) return m[2];
  }
  return undefined;
}

/** The finite set of tag names {@link findMatchingClose} is ever called with:
 * the dynamic tags matched by {@link DYNAMIC_TAG_RE} plus `<when>`/`<otherwise>`
 * (matched in {@link chooseBranchBodies}). Hardcoded per-tag literal regexes —
 * NOT `new RegExp()` built from `tagName` — so the pattern is never
 * attacker-influenced (ReDoS audit). */
function tagOpenRegex(tagName: string): RegExp | null {
  switch (tagName) {
    case "if":
      return /<if\b/gi;
    case "choose":
      return /<choose\b/gi;
    case "where":
      return /<where\b/gi;
    case "set":
      return /<set\b/gi;
    case "trim":
      return /<trim\b/gi;
    case "foreach":
      return /<foreach\b/gi;
    case "bind":
      return /<bind\b/gi;
    case "when":
      return /<when\b/gi;
    case "otherwise":
      return /<otherwise\b/gi;
    default:
      return null;
  }
}

/** Closing-tag counterpart to {@link tagOpenRegex}; see its docs. */
function tagCloseRegex(tagName: string): RegExp | null {
  switch (tagName) {
    case "if":
      return /<\/if\s*>/gi;
    case "choose":
      return /<\/choose\s*>/gi;
    case "where":
      return /<\/where\s*>/gi;
    case "set":
      return /<\/set\s*>/gi;
    case "trim":
      return /<\/trim\s*>/gi;
    case "foreach":
      return /<\/foreach\s*>/gi;
    case "bind":
      return /<\/bind\s*>/gi;
    case "when":
      return /<\/when\s*>/gi;
    case "otherwise":
      return /<\/otherwise\s*>/gi;
    default:
      return null;
  }
}

/**
 * Find the index of the `</tagName>` that matches the opening tag whose body
 * starts at `bodyStart`, correctly skipping past any nested occurrences of
 * the SAME tag name. Returns -1 when unmatched (malformed/truncated XML) or
 * when `tagName` isn't one of the tags {@link tagOpenRegex}/{@link tagCloseRegex}
 * know about.
 */
function findMatchingClose(content: string, tagName: string, bodyStart: number): number {
  const openTest = tagOpenRegex(tagName);
  const closeTest = tagCloseRegex(tagName);
  if (!openTest || !closeTest) return -1;
  let depth = 1;
  let pos = bodyStart;
  // No `while (depth > 0)` guard: every iteration returns (either -1 for an
  // unmatched close, or the close index once depth unwinds to 0), so an
  // infinite `for(;;)` needs no unreachable fallthrough return afterwards.
  for (;;) {
    openTest.lastIndex = pos;
    closeTest.lastIndex = pos;
    const openMatch = openTest.exec(content);
    const closeMatch = closeTest.exec(content);
    if (!closeMatch) return -1;
    if (openMatch && openMatch.index < closeMatch.index) {
      depth++;
      pos = openMatch.index + openMatch[0].length;
    } else {
      depth--;
      pos = closeMatch.index + closeMatch[0].length;
      if (depth === 0) return closeMatch.index;
    }
  }
}

/** Strip a single leading token (from a `|`-separated override list) off `body`. */
function stripLeadingOverride(body: string, overrides: string | undefined): string {
  if (!overrides) return body;
  const trimmed = body.trimStart();
  for (const alt of overrides.split("|")) {
    const token = alt.trim();
    if (!token) continue;
    if (trimmed.toUpperCase().startsWith(token.toUpperCase())) {
      return trimmed.slice(token.length).trimStart();
    }
  }
  return trimmed;
}

/** Strip a single trailing token (from a `|`-separated override list) off `body`. */
function stripTrailingOverride(body: string, overrides: string | undefined): string {
  if (!overrides) return body;
  const trimmed = body.trimEnd();
  for (const alt of overrides.split("|")) {
    const token = alt.trim();
    if (!token) continue;
    if (trimmed.toUpperCase().endsWith(token.toUpperCase())) {
      return trimmed.slice(0, trimmed.length - token.length).trimEnd();
    }
  }
  return trimmed;
}

/**
 * Reduce a `<where>`/`<set>`/`<trim>` body to a plain clause fragment that
 * keeps its literal keyword — tag-stripping alone drops `WHERE`/`SET` (they
 * come from the tag itself, not its children), which corrupts the
 * FROM/JOIN/SET regexes in {@link extractSqlRefs}. An all-whitespace body
 * reduces to `""` (no bare keyword), matching MyBatis's own behaviour of
 * omitting an empty `<where>`/`<set>`.
 */
function reduceTrimLike(
  inner: string,
  opts: { prefix?: string; prefixOverrides?: string; suffixOverrides?: string },
): string {
  let body = stripLeadingOverride(inner, opts.prefixOverrides);
  body = stripTrailingOverride(body, opts.suffixOverrides);
  body = body.trim();
  if (!body) return "";
  return opts.prefix ? `${opts.prefix} ${body}` : body;
}

/** Parse the immediate `<when>`/`<otherwise>` children of a `<choose>` body. */
function chooseBranchBodies(body: string): string[] {
  const branches: string[] = [];
  let pos = 0;
  const tagRe = /<(when|otherwise)\b[^>]*>/i;
  for (;;) {
    const rest = body.slice(pos);
    const m = tagRe.exec(rest);
    if (!m) break;
    const tagName = m[1].toLowerCase();
    const openEnd = pos + m.index + m[0].length;
    const closeStart = findMatchingClose(body, tagName, openEnd);
    if (closeStart === -1) break;
    branches.push(body.slice(openEnd, closeStart));
    pos = closeStart + `</${tagName}>`.length;
  }
  return branches;
}

function combineVariants(left: string[], right: string[]): string[] {
  const out: string[] = [];
  outer: for (const a of left) {
    for (const b of right) {
      if (out.length >= MAX_VARIANTS) break outer;
      out.push(a + b);
    }
  }
  return out;
}

/**
 * Expand `<if>`, `<choose>/<when>/<otherwise>`, `<foreach>`, `<where>`,
 * `<set>`, `<trim>` and `<bind>` into the UNION of every branch's SQL text
 * instead of evaluating their OGNL `test=` conditions:
 *  - `<if>`/`<foreach>` bodies are always taken (a `<foreach>` loop body
 *    exactly once — it already appears once in the source).
 *  - `<choose>` yields one variant per `<when>`/`<otherwise>` branch; nested
 *    or multiple `<choose>` blocks cartesian-combine (capped at
 *    {@link MAX_VARIANTS}).
 *  - `<where>`/`<set>`/`<trim>` reduce to a plain clause with their keyword
 *    reinstated (see {@link reduceTrimLike}).
 *  - `<bind>` never contributes a table and is dropped.
 */
function expandVariants(text: string): string[] {
  const m = DYNAMIC_TAG_RE.exec(text);
  if (!m) return [text];

  const tagName = m[1].toLowerCase();
  const attrs = m[2];
  const before = text.slice(0, m.index);
  const openEnd = m.index + m[0].length;
  const selfClosing = Boolean(m[3]) || tagName === "bind";

  if (selfClosing) {
    return expandVariants(text.slice(openEnd)).map((v) => before + v);
  }

  const closeStart = findMatchingClose(text, tagName, openEnd);
  if (closeStart === -1) {
    // Malformed/truncated dynamic tag: drop just the open-tag marker rather
    // than losing the rest of the SQL text that follows it.
    return expandVariants(text.slice(openEnd)).map((v) => before + v);
  }
  const inner = text.slice(openEnd, closeStart);
  const afterStart = closeStart + `</${tagName}>`.length;

  let tagVariants: string[];
  switch (tagName) {
    case "choose": {
      const branches = chooseBranchBodies(inner);
      tagVariants = branches.length > 0 ? branches.flatMap((b) => expandVariants(b)) : [""];
      break;
    }
    case "where":
      tagVariants = expandVariants(inner).map((v) =>
        reduceTrimLike(v, { prefix: "WHERE", prefixOverrides: "AND |OR |and |or " }),
      );
      break;
    case "set":
      tagVariants = expandVariants(inner).map((v) =>
        reduceTrimLike(v, { prefix: "SET", suffixOverrides: "," }),
      );
      break;
    case "trim":
      tagVariants = expandVariants(inner).map((v) =>
        reduceTrimLike(v, {
          prefix: readAttr(attrs, "prefix"),
          prefixOverrides: readAttr(attrs, "prefixOverrides"),
          suffixOverrides: readAttr(attrs, "suffixOverrides"),
        }),
      );
      break;
    case "if":
    case "foreach":
    default:
      tagVariants = expandVariants(inner);
      break;
  }

  const afterVariants = expandVariants(text.slice(afterStart));
  return combineVariants(tagVariants, afterVariants).map((v) => before + v);
}

/**
 * Expand `<if>`/`<choose>`/`<foreach>`/`<where>`/`<set>`/`<trim>`/`<bind>`
 * into every UNIONed SQL branch. Callers should extract refs from each
 * returned variant and union the results (see `extractSqlRefsWithDynamicTags`
 * below) — the extraction-time substitute for evaluating OGNL `test=`
 * conditions. Returns `[xml]` unchanged when there are no dynamic tags.
 */
export function expandDynamicTags(xml: string): string[] {
  return expandVariants(xml);
}

/** UNION table/column refs extracted from every dynamic-tag branch. */
function mergeTableRefs(lists: SchemaTableRef[][]): SchemaTableRef[] {
  const map = new Map<string, SchemaTableRef>();
  for (const list of lists) {
    for (const ref of list) {
      const key = ref.schema ? `${ref.schema}.${ref.table}` : ref.table;
      const existing = map.get(key);
      if (existing) {
        existing.columns = [...new Set([...existing.columns, ...ref.columns])];
      } else {
        map.set(key, { ...ref, columns: [...ref.columns] });
      }
    }
  }
  return [...map.values()];
}

/**
 * Resolve dynamic-tag branches (UNION, not OGNL evaluation) and extract the
 * full set of table/column refs across all of them. `rawSql` should already
 * have its `<include>`s inlined via {@link expandIncludeRefs}.
 */
export function extractSqlRefsWithDynamicTags(
  rawSql: string,
  sqlKind: MyBatisStatement["sqlKind"],
): SchemaTableRef[] {
  return mergeTableRefs(expandDynamicTags(rawSql).map((v) => extractSqlRefs(v, sqlKind)));
}

// ---- XML mapper parsing ----------------------------------------------------

const STATEMENT_KINDS = ["select", "insert", "update", "delete"] as const;

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

/** Parse an XML MyBatis mapper into statements. */
export function parseMyBatisXml(content: string): MyBatisStatement[] {
  const nsMatch = /<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i.exec(content);
  const namespace = nsMatch ? nsMatch[1].trim() : null;

  // Collect <sql id="..."> fragments for <include refid="..."> expansion.
  const fragments = new Map<string, string>();
  const sqlFragRe = /<sql\b[^>]*\bid\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/sql>/gi;
  let f: RegExpExecArray | null;
  while ((f = sqlFragRe.exec(content)) !== null) {
    fragments.set(f[1], f[2]);
  }

  const statements: MyBatisStatement[] = [];
  for (const kind of STATEMENT_KINDS) {
    const re = new RegExp(`<${kind}\\b([^>]*)>([\\s\\S]*?)<\\/${kind}>`, "gi");
    let s: RegExpExecArray | null;
    while ((s = re.exec(content)) !== null) {
      const attrs = s[1];
      const idMatch = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs);
      if (!idMatch) continue;
      const statementId = idMatch[1];
      const body = expandIncludeRefs(s[2], fragments);
      const refs = extractSqlRefsWithDynamicTags(body, kind);
      if (refs.length === 0) continue;
      statements.push({
        statementId,
        namespace,
        qualifiedName: namespace ? `${namespace}.${statementId}` : statementId,
        sqlKind: kind,
        line: lineOf(content, s.index),
        refs,
      });
    }
  }
  return statements;
}

// ---- Annotation mapper parsing ---------------------------------------------

function extractAnnotationSql(raw: string): string {
  // Handles "..." , { "...", "..." } arrays, and text blocks """...""".
  const blocks = [...raw.matchAll(/"""([\s\S]*?)"""/g)].map((b) => b[1]);
  if (blocks.length > 0) return blocks.join(" ");
  const strings = [...raw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((b) => b[1]);
  return strings.join(" ");
}

/**
 * Read a balanced `(...)` argument list starting at `open` (the index of the
 * `(`), ignoring parentheses that appear inside string literals or text blocks.
 * Returns the inner content and the index just past the closing `)`.
 */
function readBalancedArgs(content: string, open: number): { inner: string; end: number } {
  let depth = 0;
  let i = open;
  let inString = false;
  let stringQuote = "";
  for (; i < content.length; i++) {
    const ch = content[i];
    if (inString) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (content.startsWith('"""', i) && stringQuote === '"""') {
        i += 2;
        inString = false;
        continue;
      }
      if (ch === stringQuote && stringQuote === '"') inString = false;
      continue;
    }
    if (content.startsWith('"""', i)) {
      inString = true;
      stringQuote = '"""';
      i += 2;
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringQuote = '"';
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return { inner: content.slice(open + 1, i), end: i + 1 };
    }
  }
  return { inner: content.slice(open + 1), end: content.length };
}

/**
 * From just after an annotation's closing paren, find the mapped method name,
 * skipping any further annotations (`@Options(...)`), modifiers and the return
 * type. Returns the method name or null.
 */
function findMethodName(content: string, from: number): string | null {
  let rest = content.slice(from);
  // Drop leading annotations (with optional balanced arg lists).
  for (;;) {
    const ann = /^\s*@\w+/.exec(rest);
    if (!ann) break;
    let cut = ann[0].length;
    const afterAnn = rest.slice(cut);
    const paren = /^\s*\(/.exec(afterAnn);
    if (paren) {
      const openIdx = cut + afterAnn.indexOf("(");
      cut = readBalancedArgs(rest, openIdx).end;
    }
    rest = rest.slice(cut);
  }
  const m = /\b([A-Za-z_]\w*)\s*\(/.exec(rest);
  return m ? m[1] : null;
}

/** Parse a Java MyBatis annotation mapper interface into statements. */
export function parseMyBatisAnnotations(content: string): MyBatisStatement[] {
  const pkg = /\bpackage\s+([A-Za-z0-9_.]+)\s*;/.exec(content);
  const iface = /\binterface\s+([A-Za-z0-9_]+)/.exec(content);
  const namespace = iface ? (pkg ? `${pkg[1]}.${iface[1]}` : iface[1]) : null;

  const statements: MyBatisStatement[] = [];
  const annRe = /@(Select|Insert|Update|Delete)\s*\(/g;
  let a: RegExpExecArray | null;
  while ((a = annRe.exec(content)) !== null) {
    const kind = a[1].toLowerCase() as MyBatisStatement["sqlKind"];
    const openIdx = a.index + a[0].length - 1;
    const { inner, end } = readBalancedArgs(content, openIdx);
    const statementId = findMethodName(content, end);
    if (!statementId) continue;
    const sql = extractAnnotationSql(inner);
    // Annotation SQL can itself carry a `<script>`-wrapped dynamic-SQL body
    // (MyBatis's `@Select("<script>...</script>")` form), so it goes through
    // the same UNION expansion as XML mapper statements.
    const refs = extractSqlRefsWithDynamicTags(sql, kind);
    if (refs.length === 0) continue;
    statements.push({
      statementId,
      namespace,
      qualifiedName: namespace ? `${namespace}.${statementId}` : statementId,
      sqlKind: kind,
      line: lineOf(content, a.index),
      refs,
    });
    annRe.lastIndex = end;
  }
  return statements;
}

/** Dispatch by file type/content: XML mappers vs annotation mappers. */
export function extractMyBatis(filePath: string, content: string): MyBatisStatement[] {
  if (/\.xml$/i.test(filePath)) {
    if (!/<mapper\b/i.test(content)) return [];
    return parseMyBatisXml(content);
  }
  if (/\.java$/i.test(filePath)) {
    if (!/@(Select|Insert|Update|Delete)\b/.test(content)) return [];
    return parseMyBatisAnnotations(content);
  }
  return [];
}

// ---- Persistence -----------------------------------------------------------

/**
 * One MyBatis statement's synthetic origin symbol, as created below — handed
 * back to the caller (via `originsOut`, Issue #887) so a later pass can
 * connect the origin to the REAL Java mapper interface method it belongs to
 * (`mybatis-callsite-extractor.ts`'s `persistMyBatisStatementOriginEdges`).
 */
export interface MyBatisStatementOrigin {
  symbolId: string;
  namespace: string | null;
  statementId: string;
  qualifiedName: string;
  line: number;
}

/**
 * Persist the schema graph for one MyBatis file: a statement origin symbol per
 * statement, plus `reads`/`writes`/`persists-to` edges to every referenced
 * table and column. Returns the number of edges written.
 *
 * `originsOut`, when provided, is appended with one {@link MyBatisStatementOrigin}
 * per statement (Issue #887) so the ingest pipeline can run a follow-up pass
 * connecting each origin to its real Java mapper interface method — purely
 * additive, existing callers that omit it are unaffected.
 */
export async function persistMyBatisFile(
  writer: SchemaGraphWriter,
  filePath: string,
  content: string,
  originsOut?: MyBatisStatementOrigin[],
): Promise<number> {
  const statements = extractMyBatis(filePath, content);
  let edges = 0;
  for (const stmt of statements) {
    const fromId = await writer.createOriginSymbol(
      "method",
      stmt.statementId,
      stmt.qualifiedName,
      filePath,
      stmt.line,
    );
    originsOut?.push({
      symbolId: fromId,
      namespace: stmt.namespace,
      statementId: stmt.statementId,
      qualifiedName: stmt.qualifiedName,
      line: stmt.line,
    });
    for (const ref of stmt.refs) {
      const kind = ACCESS_EDGE_KIND[ref.access];
      // A `${...}` raw-substitution table (#886) can't be resolved to a real
      // table by parsing alone; it targets a synthetic placeholder symbol
      // instead of a bogus concrete table, and the edge carries an
      // `unresolved` metadata marker so downstream consumers (e.g. #895's gap
      // report) can find it.
      const tableName = ref.unresolved ? dynamicPlaceholderName(ref.placeholder!) : ref.table;
      const tableId = await writer.ensureTable(tableName, "mybatis", {
        schema: ref.unresolved ? undefined : ref.schema,
        filePath,
        line: stmt.line,
      });
      const metadata = ref.unresolved
        ? unresolvedRefMetadata({
            placeholder: ref.placeholder!,
            statementId: stmt.statementId,
            mapper: stmt.namespace,
          })
        : undefined;
      await writer.addEdge(fromId, kind, tableId, "mybatis", {
        toQualifiedName: ref.unresolved
          ? tableName
          : ref.schema
            ? `${ref.schema}.${ref.table}`
            : ref.table,
        filePath,
        line: stmt.line,
        metadata,
      });
      edges++;
      for (const col of ref.columns) {
        const colId = await writer.ensureColumn(tableName, col, "mybatis", {
          schema: ref.unresolved ? undefined : ref.schema,
          filePath,
          line: stmt.line,
        });
        await writer.addEdge(fromId, kind, colId, "mybatis", {
          toQualifiedName: `${tableName}.${col}`,
          filePath,
          line: stmt.line,
          metadata,
        });
        edges++;
      }
    }
  }
  return edges;
}
