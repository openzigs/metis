/**
 * #1619 — the event-topic and shared-table signals a repo crawl extracts for
 * the relationship detector: which topics a repo publishes to or subscribes to
 * (from an AsyncAPI document or from producer/consumer calls in code), and
 * which tables its SQL reads or writes.
 *
 * Everything here is a pure function of file text. Comments are blanked out
 * before any pattern runs, so a topic or table named only in a comment (a
 * commented-out call, a TODO) is never a signal.
 */
import { loadYamlDocument } from "../yaml-load.js";

export type TopicRole = "publish" | "subscribe";
export type TableAccess = "read" | "write";

/** A topic a repo publishes to or subscribes to. */
export interface CrawlTopicRef {
  topic: string;
  role: TopicRole;
  filePath: string;
  lineNumber?: number;
  /** `asyncapi` when read from an AsyncAPI document, `code` from a client call. */
  source: "asyncapi" | "code";
}

/** A table a repo's SQL reads or writes. */
export interface CrawlTableRef {
  /** Lower-cased table name, qualified `schema.table` when the SQL qualified it. */
  table: string;
  access: TableAccess;
  filePath: string;
  lineNumber?: number;
}

interface CommentStyle {
  line: string[];
  block: boolean;
  backtick: boolean;
  /** Python's `"""` / `'''` strings, which span lines (#1647). */
  tripleQuote?: boolean;
}

const C_LIKE: CommentStyle = { line: ["//"], block: true, backtick: true };
const HASH: CommentStyle = { line: ["#"], block: false, backtick: false };
const PYTHON: CommentStyle = { ...HASH, tripleQuote: true };
// Known gap: MySQL's `#` line comment is not blanked, so a table named only in
// one (`# select * from t`) can still be read as a signal in a `.sql` file.
// `#` is not a comment in the other dialects, where it can be an operator.
const SQL: CommentStyle = { line: ["--"], block: true, backtick: false };

const STYLE_BY_EXTENSION: Record<string, CommentStyle> = {
  ts: C_LIKE,
  tsx: C_LIKE,
  js: C_LIKE,
  jsx: C_LIKE,
  mjs: C_LIKE,
  cjs: C_LIKE,
  java: C_LIKE,
  kt: C_LIKE,
  go: C_LIKE,
  cs: C_LIKE,
  scala: C_LIKE,
  swift: C_LIKE,
  rs: C_LIKE,
  php: C_LIKE,
  py: PYTHON,
  rb: HASH,
  sh: HASH,
  yaml: HASH,
  yml: HASH,
  sql: SQL,
};

function extensionOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  return dot === -1 ? "" : filePath.slice(dot + 1).toLowerCase();
}

/** Whether the crawler should look for signals in this file at all. */
export function isSignalSource(filePath: string): boolean {
  return extensionOf(filePath) in STYLE_BY_EXTENSION;
}

export interface LexedSource {
  /** The text with every comment blanked to spaces; newlines kept, so offsets and lines hold. */
  code: string;
  /**
   * Every string literal, in source order: its content, the offset of its
   * opening quote and the offset just past its closing one.
   */
  strings: Array<{ value: string; offset: number; end: number }>;
}

/**
 * Blank the comments out of a source file and collect its string literals. A
 * small lexer, not a parser: it knows `'`, `"` and (C-like languages) `` ` ``
 * strings with backslash escapes, Python's triple-quoted strings, and the line
 * / block comments of the file's language. An unterminated `'` or `"` string
 * ends at the line break.
 */
export function lexSource(content: string, filePath: string): LexedSource {
  const style = STYLE_BY_EXTENSION[extensionOf(filePath)];
  if (!style) return { code: content, strings: [] };
  const out = content.split("");
  const strings: LexedSource["strings"] = [];
  let i = 0;
  while (i < content.length) {
    const c = content[i];
    const triple = style.tripleQuote && (c === '"' || c === "'") ? c.repeat(3) : null;
    if (triple && content.startsWith(triple, i)) {
      const close = content.indexOf(triple, i + 3);
      const stop = close === -1 ? content.length : close;
      strings.push({ value: content.slice(i + 3, stop), offset: i, end: stop + 3 });
      i = stop + 3;
      continue;
    }
    if (c === '"' || c === "'" || (c === "`" && style.backtick)) {
      const start = i;
      i++;
      while (i < content.length && content[i] !== c) {
        if (content[i] === "\\") i++;
        else if (content[i] === "\n" && c !== "`") break;
        i++;
      }
      strings.push({
        value: content.slice(start + 1, Math.min(i, content.length)),
        offset: start,
        end: i + 1,
      });
      i++;
      continue;
    }
    if (style.line.some((token) => content.startsWith(token, i))) {
      while (i < content.length && content[i] !== "\n") out[i++] = " ";
      continue;
    }
    if (style.block && content.startsWith("/*", i)) {
      const end = content.indexOf("*/", i + 2);
      const stop = end === -1 ? content.length : end + 2;
      for (; i < stop; i++) if (content[i] !== "\n") out[i] = " ";
      continue;
    }
    i++;
  }
  return { code: out.join(""), strings };
}

/**
 * A 1-based line lookup for `content`, by binary search over its line starts,
 * so a file with many signals costs one pass rather than one pass per signal.
 */
function lineIndex(content: string): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < content.length; i++) if (content[i] === "\n") starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

// ---- Topics -----------------------------------------------------------------

const Q = "[\"'`]";
const TOPIC = "([A-Za-z0-9][\\w.\\-/:]{0,199})";
const TOPIC_LIST = "\\[([^\\]]{0,2000})\\]";

/**
 * Producer and consumer calls of the common clients: kafkajs, node-rdkafka,
 * kafka-python / confluent-kafka, Spring Kafka, and the `publish` / `subscribe`
 * of NATS, Redis and MQTT clients. Each is bounded (no nested quantifiers).
 */
const TOPIC_PATTERNS: Array<{ role: TopicRole; re: RegExp; list?: boolean }> = [
  // kafkajs: producer.send({ topic: 'x', ... })
  { role: "publish", re: new RegExp(`\\.send\\(\\s*\\{\\s*topic\\s*:\\s*${Q}${TOPIC}${Q}`, "g") },
  // node-rdkafka: producer.produce('x', ...)
  { role: "publish", re: new RegExp(`\\.produce\\(\\s*${Q}${TOPIC}${Q}`, "g") },
  // kafka-python / Spring: producer.send('x', ...), kafkaTemplate.send("x", ...)
  {
    role: "publish",
    re: new RegExp(`\\b\\w*(?:[Pp]roducer|[Tt]emplate)\\.send\\(\\s*${Q}${TOPIC}${Q}`, "g"),
  },
  // NATS / Redis / MQTT: client.publish('x', ...)
  { role: "publish", re: new RegExp(`\\.publish\\(\\s*${Q}${TOPIC}${Q}`, "g") },
  // kafkajs: consumer.subscribe({ topic: 'x' }) and { topics: ['x', 'y'] }
  {
    role: "subscribe",
    re: new RegExp(`\\.subscribe\\(\\s*\\{\\s*topic\\s*:\\s*${Q}${TOPIC}${Q}`, "g"),
  },
  {
    role: "subscribe",
    re: new RegExp(`\\.subscribe\\(\\s*\\{\\s*topics\\s*:\\s*${TOPIC_LIST}`, "g"),
    list: true,
  },
  // kafka-python / confluent: consumer.subscribe(['x']); NATS / Redis: .subscribe('x')
  { role: "subscribe", re: new RegExp(`\\.subscribe\\(\\s*${TOPIC_LIST}`, "g"), list: true },
  { role: "subscribe", re: new RegExp(`\\.subscribe\\(\\s*${Q}${TOPIC}${Q}`, "g") },
  // kafka-python: KafkaConsumer('x', ...)
  { role: "subscribe", re: new RegExp(`\\bKafkaConsumer\\(\\s*${Q}${TOPIC}${Q}`, "g") },
  // Spring Kafka: @KafkaListener(topics = "x") / topics = {"x", "y"}
  {
    role: "subscribe",
    re: new RegExp(`@KafkaListener\\([^)]{0,500}?topics\\s*=\\s*\\{?\\s*${Q}${TOPIC}${Q}`, "g"),
  },
];

const QUOTED_TOPIC = new RegExp(`${Q}${TOPIC}${Q}`, "g");

/**
 * Whether `offset` falls inside one of `strings` (sorted by offset, as the
 * lexer emits them), by binary search.
 */
function insideString(strings: LexedSource["strings"], offset: number): boolean {
  let lo = 0;
  let hi = strings.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strings[mid].end <= offset) lo = mid + 1;
    else if (strings[mid].offset > offset) hi = mid - 1;
    else return true;
  }
  return false;
}

/**
 * The topics a source file's (uncommented) code publishes to or subscribes to.
 * A call written inside a string literal or a docstring (an example, a log
 * message) is not code, so it is no signal (#1647).
 */
export function extractTopicRefs(filePath: string, content: string): CrawlTopicRef[] {
  if (!isSignalSource(filePath) || /\.(ya?ml|sql)$/i.test(filePath)) return [];
  const { code, strings } = lexSource(content, filePath);
  const lineAt = lineIndex(content);
  const refs: CrawlTopicRef[] = [];
  const seen = new Set<string>();
  for (const { role, re, list } of TOPIC_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      if (insideString(strings, m.index)) continue;
      const names = list ? [...m[1].matchAll(QUOTED_TOPIC)].map((q) => q[1]) : [m[1]];
      for (const topic of names) {
        const key = `${role}:${topic}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ topic, role, filePath, lineNumber: lineAt(m.index), source: "code" });
      }
    }
  }
  return refs;
}

/** True when a YAML/JSON document is an AsyncAPI document (it has an `asyncapi` version). */
export function isAsyncApiDocument(content: string): boolean {
  return /^\s*["']?asyncapi["']?\s*:/m.test(content);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The channels an AsyncAPI document says its application sends to or receives
 * from. 2.x names operations from the CLIENT's side: a channel's `subscribe`
 * operation is what the application publishes, `publish` what it consumes. 3.x
 * says it plainly with `operations.*.action` (`send` / `receive`) and a
 * `channel.$ref`, and a channel's `address` is the topic (its key when absent).
 * A document that does not parse yields nothing.
 */
export function parseAsyncApiChannels(
  filePath: string,
  content: string,
): Array<{ topic: string; role: TopicRole }> {
  let doc: Record<string, unknown> | null;
  try {
    doc = asRecord(loadYamlDocument(content, { schema: "core", filename: filePath }));
  } catch {
    return [];
  }
  if (!doc || doc.asyncapi === undefined) return [];
  const channels = asRecord(doc.channels) ?? {};
  const out: Array<{ topic: string; role: TopicRole }> = [];
  const version = String(doc.asyncapi);
  if (version.startsWith("2")) {
    for (const [name, raw] of Object.entries(channels)) {
      const channel = asRecord(raw) ?? {};
      if (channel.subscribe) out.push({ topic: name, role: "publish" });
      if (channel.publish) out.push({ topic: name, role: "subscribe" });
    }
    return out;
  }
  const operations = asRecord(doc.operations) ?? {};
  for (const raw of Object.values(operations)) {
    const op = asRecord(raw) ?? {};
    const ref = asRecord(op.channel)?.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/channels/")) continue;
    // A JSON-pointer segment escapes `/` as `~1` and `~0` as `~` (RFC 6901),
    // decoded in that order; an inherited name (`constructor`) is no channel.
    const key = ref.slice("#/channels/".length).replace(/~1/g, "/").replace(/~0/g, "~");
    if (!Object.hasOwn(channels, key)) continue;
    const channel = asRecord(channels[key]);
    if (!channel) continue;
    const topic = typeof channel.address === "string" ? channel.address : key;
    if (op.action === "send") out.push({ topic, role: "publish" });
    if (op.action === "receive") out.push({ topic, role: "subscribe" });
  }
  return out;
}

// ---- Tables -----------------------------------------------------------------

const IDENT = '["`\\[]?([A-Za-z_][\\w$]{0,127})["`\\]]?';
// The whole name or nothing: backtracking must not shorten `generate_series(`
// into a table `generate_serie`.
const TABLE = `${IDENT}(?:\\.${IDENT})?(?![\\w$.])`;
const WRITE_PATTERNS: RegExp[] = [
  new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+${TABLE}`, "gi"),
  new RegExp(`\\bupdate\\s+${TABLE}\\s+set\\b`, "gi"),
  new RegExp(`\\bdelete\\s+from\\s+${TABLE}`, "gi"),
  new RegExp(`\\bmerge\\s+into\\s+${TABLE}`, "gi"),
];
/**
 * A table read: FROM or JOIN a name that is not a function call
 * (`generate_series(`), and not the FROM of `IS [NOT] DISTINCT FROM` (#1647).
 */
const READ_PATTERN = new RegExp(
  `(?<!\\bdistinct\\s{1,16})\\b(?:from|join)\\s+${TABLE}(?!\\s*\\()`,
  "gi",
);
const SELECT = /\bselect\b/i;

/**
 * #1647 — the functions whose arguments take a FROM that names no table:
 * `EXTRACT(YEAR FROM col)`, `TRIM(LEADING 'x' FROM col)`, `SUBSTRING(s FROM 2)`.
 */
const NON_TABLE_FROM_CALLS = new Set([
  "extract",
  "trim",
  "substring",
  "substr",
  "overlay",
  "position",
]);

/**
 * #1647 — the names a statement's common table expressions define (`WITH recent
 * AS (...)`, `, totals(a, b) AS MATERIALIZED (...)`): a FROM of one reads the
 * CTE, not a table.
 */
const CTE_NAME = new RegExp(
  `(?:\\bwith(?:\\s+recursive)?|,)\\s*["\`\\[]?([A-Za-z_][\\w$]{0,127})["\`\\]]?(?:\\s*\\([^()]{0,1000}\\))?\\s+as\\s+(?:(?:not\\s+)?materialized\\s+)?\\(`,
  "gi",
);

/** A string literal in code is scanned only when it opens with a SQL statement verb. */
const SQL_LITERAL = /^\s*(?:select|insert|update|delete|merge|with)\b/i;

/**
 * #1647 — a literal whose verb is sentence-cased ("Select from the list",
 * "Delete from cart") is UI prose unless something only SQL has follows: an
 * operator or placeholder, or a clause keyword.
 *
 * #1657 — not `?` or `,`: prose has both ("Delete from cart?", "Select from
 * the list, then save"). A `?` placeholder comes with an `=` or a `(`, which
 * are markers. What this misses is a sentence-cased select list with nothing
 * else SQL-only ("Select id, name from users"): an edge missed, never invented.
 */
const SENTENCE_CASE_VERB = /^\s*[A-Z][a-z]+\b/;
const SQL_MARKER =
  /[*=();]|\$\d|:\w|\b(?:where|values|set|join|group\s+by|order\s+by|limit|returning)\b/i;

/** #1647 — words that follow a FROM in prose and are never a table ("from the list"). */
const PROSE_WORDS = new Set([
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "my",
  "your",
  "our",
  "their",
  "his",
  "her",
  "its",
  "each",
  "every",
  "any",
  "some",
  "all",
  "here",
  "there",
]);

/** Whether a string literal in code reads as SQL, not prose. */
function isSqlLiteral(value: string): boolean {
  if (!SQL_LITERAL.test(value)) return false;
  return !SENTENCE_CASE_VERB.test(value) || SQL_MARKER.test(value);
}

/**
 * `text` with the arguments of every {@link NON_TABLE_FROM_CALLS} call blanked
 * to spaces (offsets kept), in one pass over a stack of open parentheses. A
 * character is blanked when the innermost parenthesis around it is such a
 * call's, so a subquery inside one (`EXTRACT(YEAR FROM (SELECT d FROM t))`)
 * keeps its FROM (#1657), and nesting them costs no second pass.
 */
function blankNonTableFromCalls(text: string): string {
  const out = text.split("");
  const open: boolean[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(") {
      let j = i - 1;
      while (j >= 0 && (text[j] === " " || text[j] === "\t")) j--;
      let k = j;
      while (k >= 0 && /[\w$]/.test(text[k])) k--;
      open.push(NON_TABLE_FROM_CALLS.has(text.slice(k + 1, j + 1).toLowerCase()));
    } else if (c === ")") {
      open.pop();
    } else if (open.length > 0 && open[open.length - 1] && c !== "\n") {
      out[i] = " ";
    }
  }
  return out.join("");
}

type FoundTable = { table: string; access: TableAccess; index: number };

function collect(re: RegExp, text: string, access: TableAccess, base: number, out: FoundTable[]) {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({
      table: (m[2] ? `${m[1]}.${m[2]}` : m[1]).toLowerCase(),
      access,
      index: base + m.index,
    });
  }
}

/**
 * Writes anywhere; reads only inside a statement (split on `;`) that SELECTs,
 * so the FROM of a `DELETE FROM` is not a read and prose is not SQL. Every pass
 * is linear in the text: no pattern spans an unbounded gap.
 */
function tableRefsIn(text: string): FoundTable[] {
  const out: FoundTable[] = [];
  for (const re of WRITE_PATTERNS) collect(re, text, "write", 0, out);
  let offset = 0;
  for (const statement of blankNonTableFromCalls(text).split(";")) {
    if (SELECT.test(statement)) {
      const ctes = new Set([...statement.matchAll(CTE_NAME)].map((m) => m[1].toLowerCase()));
      const reads: FoundTable[] = [];
      collect(READ_PATTERN, statement, "read", offset, reads);
      out.push(...reads.filter((r) => !ctes.has(r.table)));
    }
    offset += statement.length + 1;
  }
  return out;
}

/**
 * The tables a file's SQL reads or writes: the whole (uncommented) text of a
 * `.sql` file, and in code every string literal that reads as SQL rather than
 * prose (it opens with a SQL verb; a sentence-cased one also needs something
 * only SQL has), naming no prose word as a table (#1647). A write wins over a
 * read of the same table in the same file.
 */
export function extractTableRefs(filePath: string, content: string): CrawlTableRef[] {
  if (!isSignalSource(filePath) || /\.ya?ml$/i.test(filePath)) return [];
  const lexed = lexSource(content, filePath);
  const found =
    extensionOf(filePath) === "sql"
      ? tableRefsIn(lexed.code)
      : lexed.strings
          .filter((s) => isSqlLiteral(s.value))
          .flatMap((s) =>
            tableRefsIn(s.value)
              .filter((r) => !PROSE_WORDS.has(r.table))
              .map((r) => ({ ...r, index: s.offset })),
          );
  const lineAt = lineIndex(content);
  const byTable = new Map<string, CrawlTableRef>();
  for (const r of found) {
    const prior = byTable.get(r.table);
    if (prior && (prior.access === "write" || r.access === "read")) continue;
    byTable.set(r.table, {
      table: r.table,
      access: r.access,
      filePath,
      lineNumber: lineAt(r.index),
    });
  }
  return [...byTable.values()];
}
