/**
 * #1223 — the main part of a reader-layout BRD (#1175) is read and signed off
 * by people who do not read code (sign-off rubric SO3, `docs/walkthroughs/
 * TEST_PLAN.md`). The #1074 comparison found both DeepSeek and Sonnet 5.5
 * writing its Capabilities and requirements as an engineering spec: function
 * names, file paths, column names. Both models failed the same way, so the
 * fix is in the prompt and in a check, not in the model.
 *
 *  - {@link MAIN_PART_LANGUAGE_RULES}: appended to each main section's
 *    instructions. It overrides the shared system prompt's "inline code for
 *    entity names" and "quote names verbatim" rules for that section only;
 *    the appendix keeps them.
 *  - {@link findCodeIdentifiers}: a deterministic check of a main section as
 *    fitted. It only FLAGS — the result is recorded per section in the
 *    provenance manifest (`codeIdentifiers`) — and never rewrites. A rewrite
 *    would be another model call per section, and it would change text whose
 *    claims were already judged against the facts, after the judging.
 *
 * Pure: no I/O and no model calls.
 */

/**
 * The business-language rule for every main section of the reader layout.
 * SO3 allows code names "where a reader acts on it (a setting an
 * administrator changes, a status a user sees)", so this does too.
 */
export const MAIN_PART_LANGUAGE_RULES = `WRITE FOR A BUSINESS READER. This part of the document is read and signed off by people who do not read code. For this section these rules override any instruction above to put names in inline code or to quote entity names verbatim:
- Say what the system does, for whom, and why it matters to them: name the people (a reader, an administrator), the business things (an article, a feed, a subscription) and the outcomes, never the code that implements them.
- Do not write function, method, class, type, constant, variable, package or module names; file paths or line numbers; database table or column names; SQL; HTTP methods, status codes, headers or endpoints; or internal error strings. Describe the behaviour instead: "when a reader opens an article it is marked as read", not "\`ShouldMarkAsReadOnView(user)\` flips \`EntryStatusUnread\` to \`EntryStatusRead\`".
- Use no inline code (backticks) and no code blocks. Two things may be named, as plain text: a setting an administrator changes, and a status or label a user sees on screen.
- Give concrete values (limits, defaults, periods, counts) in plain units: "at most 1,000 articles per request", "after 60 days".
- The code names, file paths and implementation detail belong in the appendix, which is written separately: leave them to it.
- Keep citing sources exactly as instructed. Citations become footnotes, so a reader can follow a statement back to the code without the code appearing in the text.`;

/** What kind of code a flagged span is. */
export const CODE_IDENTIFIER_KINDS = [
  "inline-code",
  "code-block",
  "file-path",
  "function-call",
  "snake-case",
  "camel-case",
  "sql",
] as const;
export type CodeIdentifierKind = (typeof CODE_IDENTIFIER_KINDS)[number];

export interface CodeIdentifierHit {
  kind: CodeIdentifierKind;
  text: string;
}

/** What a main section's check records in provenance. */
export interface CodeIdentifierReport {
  /** Distinct flagged texts. */
  count: number;
  /** The first {@link CODE_IDENTIFIER_EXAMPLES_MAX} of them, in document order. */
  examples: CodeIdentifierHit[];
}

export const CODE_IDENTIFIER_EXAMPLES_MAX = 10;
const EXAMPLE_MAX_CHARS = 80;

// ── What is read past ─────────────────────────────────────────────────────

/** A citation marker; METIS renders it as a footnote at assembly (#737). */
const CITATION_MARKER_RE = /\[\s*(?:facts|rag|web):[^\]\n]*(?:\]|$)/gm;
/** A bare citation id the model copied into prose, optionally in backticks. */
const BARE_CITATION_ID_RE = /`?\b(?:facts|rag|web):[^\s\])`,;]+`?/g;
const FOOTNOTE_DEFINITION_RE = /^\[\^[^\]\n]+\]:.*$/gm;
const FOOTNOTE_REFERENCE_RE = /\[\^[^\]\n]+\]/g;
/** The target of a markdown link; its text is still read. A URL (autolinks included) goes by `BARE_URL_RE`. */
const LINK_TARGET_RE = /(?<=\])\([^)\n]*\)/g;
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>()\]]+/g;
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const DISPLAY_MATH_RE = /\$\$[\s\S]*?\$\$/g;

// ── What is flagged ───────────────────────────────────────────────────────

const INLINE_CODE_RE = /``(.+?)``|`([^`\n]+)`/g;
/** A setting name an administrator changes (SO3 allows it): `POLLING_FREQUENCY`. */
const SETTING_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/**
 * Inside backticks, code punctuation, a member access, an inner capital or a
 * `name: value` pair marks code. A plain word or phrase in backticks (a status
 * a user sees, a number) does not.
 */
const CODE_IN_SPAN_RE = /[_(){}[\]=<>;\\/]|::|->|[A-Za-z]\.[A-Za-z]|[a-z][A-Z]|\w:\s?\S/;
/** SQL that business prose never says, in capitals as SQL writes it. */
const SQL_SOURCE = String.raw`\b(?:FOR UPDATE(?: SKIP LOCKED| NOWAIT)?|SKIP LOCKED|SELECT\b[^.\n]{0,80}?\bFROM|INSERT INTO|DELETE FROM|NOT NULL|PRIMARY KEY|FOREIGN KEY|ORDER BY|GROUP BY|(?:LEFT|RIGHT|INNER|OUTER) JOIN)\b`;
const SQL_RE = new RegExp(SQL_SOURCE, "g");

const CODE_EXTENSIONS = [
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "go",
  "py",
  "java",
  "kt",
  "kts",
  "scala",
  "rs",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "rb",
  "php",
  "swift",
  "m",
  "vue",
  "svelte",
  "sql",
  "sas",
  "cbl",
  "cob",
  "cpy",
  "sh",
  "ps1",
  "proto",
  "gradle",
  "yaml",
  "yml",
  "json",
  "toml",
  "xml",
  "html",
  "css",
  "scss",
];
/**
 * Extensions flagged on a bare file name (no directory, no line): not `js`,
 * which names products (Node.js, Next.js), nor a one-letter one.
 */
const BARE_FILE_EXTENSIONS: ReadonlySet<string> = new Set(
  CODE_EXTENSIONS.filter((ext) => ext !== "js" && ext.length > 1),
);
const FILE_PATH_RE = new RegExp(
  String.raw`(?<![\w/.-])((?:[\w.-]+/)*)([\w-]+(?:\.[\w-]+)*)\.(${CODE_EXTENSIONS.join("|")})(:\d+(?:-\d+)?)?(?![\w/-])`,
  "g",
);
const CALL_RE = /(?<![\w$.])([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\(([^()\n]{0,80})\)/g;
const SNAKE_CASE_RE = /(?<![\w$])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w$])/g;
/**
 * Lower camel case with at least two letters before the first capital and a
 * lower-case letter after it: `markAsRead`, but not iPhone, eBay or macOS.
 */
const CAMEL_CASE_RE = /(?<![\w$])[a-z][a-z0-9]+([A-Z][A-Za-z0-9]*)(?![\w$])/g;

interface Positioned extends CodeIdentifierHit {
  at: number;
}

/**
 * `text` with every character of each match of `re` (a global regex) made a
 * space, newlines kept, so offsets still point into the section as written.
 */
function blank(text: string, re: RegExp, onMatch?: (match: RegExpExecArray) => void): string {
  const parts: string[] = [];
  let from = 0;
  for (const match of text.matchAll(re)) {
    onMatch?.(match as RegExpExecArray);
    parts.push(text.slice(from, match.index), match[0].replace(/[^\n]/g, " "));
    from = match.index + match[0].length;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Fenced blocks blanked; every fence that is not a Mermaid diagram is a hit. */
function blankFences(markdown: string, hits: Positioned[]): string {
  const out: string[] = [];
  let fence: { marker: string; mermaid: boolean } | null = null;
  let at = 0;
  for (const line of markdown.split("\n")) {
    const open = /^\s*(`{3,}|~{3,})\s*([^\s`]*)/.exec(line);
    if (fence) {
      out.push(line.replace(/[^\n]/g, " "));
      if (open && open[1].startsWith(fence.marker)) fence = null;
    } else if (open) {
      const lang = open[2];
      fence = { marker: open[1], mermaid: lang.toLowerCase() === "mermaid" };
      if (!fence.mermaid) hits.push({ kind: "code-block", text: `${open[1]}${lang}`, at });
      out.push(line.replace(/[^\n]/g, " "));
    } else {
      out.push(line);
    }
    at += line.length + 1;
  }
  return out.join("\n");
}

/**
 * Every code identifier in a main-part section, in document order (each
 * occurrence). The heuristic, in the order it reads:
 *
 *  1. Read past what is not prose a reader is asked to understand, or what
 *     METIS renders itself: Mermaid diagrams, HTML comments, display math,
 *     citation markers and bare citation ids (they become footnotes), footnote
 *     references and definitions, link targets and URLs.
 *  2. Flag a fenced code block, and an inline-code span holding code (code
 *     punctuation, a member access, an inner capital, a `name: value` pair or
 *     SQL). A plain word in backticks is not flagged, nor a setting name in
 *     capitals.
 *  3. In the prose left: SQL clauses in capitals; file paths with a source
 *     extension (any with a directory or a `:line`; bare, any but `.js` and
 *     one-letter ones); calls whose name is code-shaped (an underscore, a dot
 *     or an inner capital) or which take no arguments; `snake_case`; and
 *     `lowerCamelCase` with two or more letters before the first capital.
 *
 * Ordinary capitalised words, PascalCase brand names (GitHub, PostgreSQL),
 * acronyms, hyphenated words, `SCREAMING_SNAKE` settings and plurals such as
 * `user(s)` are never flagged.
 */
export function findCodeIdentifiers(markdown: string): CodeIdentifierHit[] {
  const hits: Positioned[] = [];
  const push =
    (kind: CodeIdentifierKind, text: (m: RegExpExecArray) => string = (m) => m[0]) =>
    (m: RegExpExecArray): void => {
      hits.push({ kind, text: text(m), at: m.index });
    };
  let text = blankFences(markdown, hits);
  for (const re of [
    HTML_COMMENT_RE,
    DISPLAY_MATH_RE,
    FOOTNOTE_DEFINITION_RE,
    CITATION_MARKER_RE,
    BARE_CITATION_ID_RE,
    FOOTNOTE_REFERENCE_RE,
    LINK_TARGET_RE,
    BARE_URL_RE,
  ]) {
    text = blank(text, re);
  }
  text = blank(text, INLINE_CODE_RE, (m) => {
    const content = (m[1] ?? m[2] ?? "").trim();
    if (!content || SETTING_NAME_RE.test(content)) return;
    if (CODE_IN_SPAN_RE.test(content) || new RegExp(SQL_SOURCE).test(content)) {
      hits.push({ kind: "inline-code", text: content, at: m.index });
    }
  });
  text = blank(text, SQL_RE, push("sql"));
  text = blank(text, FILE_PATH_RE, (m) => {
    const [, dir, stem, ext, line] = m;
    if (!dir && !line && !BARE_FILE_EXTENSIONS.has(ext)) return;
    if (ext === "js" && !line && /^[A-Z]/.test(stem)) return;
    push("file-path")(m);
  });
  text = blank(text, CALL_RE, (m) => {
    if (/[_.$]|[a-z][A-Z]/.test(m[1]) || m[2].trim() === "") push("function-call")(m);
  });
  text = blank(text, SNAKE_CASE_RE, push("snake-case"));
  blank(text, CAMEL_CASE_RE, (m) => {
    if (/[a-z]/.test(m[1])) push("camel-case")(m);
  });
  return hits.sort((a, b) => a.at - b.at).map(({ kind, text: t }) => ({ kind, text: t }));
}

/** What {@link findCodeIdentifiers} found, as provenance records it. */
export function codeIdentifierReport(markdown: string): CodeIdentifierReport {
  const seen = new Set<string>();
  const examples: CodeIdentifierHit[] = [];
  for (const hit of findCodeIdentifiers(markdown)) {
    if (seen.has(hit.text)) continue;
    seen.add(hit.text);
    if (examples.length < CODE_IDENTIFIER_EXAMPLES_MAX) {
      examples.push({
        kind: hit.kind,
        text:
          hit.text.length > EXAMPLE_MAX_CHARS
            ? `${hit.text.slice(0, EXAMPLE_MAX_CHARS - 1)}…`
            : hit.text,
      });
    }
  }
  return { count: seen.size, examples };
}
