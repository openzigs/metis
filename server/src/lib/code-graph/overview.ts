/**
 * Epic #298 / Issue #313 — deterministic project_overview.md generator.
 *
 * Pure graph-statistics + rationale concatenation. NO LLM in v1: every byte
 * of output is reproducible from the persisted CodeGraph + Finding rows.
 *
 * Algorithm:
 *   1. Top-20 god-nodes — `CodeSymbol` ordered by inbound `calls`/`references`
 *      edge count DESC, ties broken by qualifiedName ASC for determinism.
 *   2. Top-10 entry points — `function`/`method` symbols whose inbound
 *      `calls` edge count is zero AND whose `filePath` matches a known
 *      entry-point glob (bin/*, cmd/*, src/index.*, src/main.*, **\/server.*,
 *      **\/cli.*).
 *   3. Summary paragraph — concatenate the `body` of `Finding` rows where
 *      `category='rationale'` and `symbolId IN (top-5-god-node-ids)`,
 *      light dedupe, prefixed by an auto-generated sentence describing the
 *      symbol/edge counts and primary languages.
 *
 * The function takes a Prisma-shaped object as its first argument so it is
 * trivially mockable in tests (matches the pattern already established by
 * the MCP query tools in `images/mcp-wrappers/code-graph-runner-sse/queries/`).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface OverviewPrismaShape {
  codeGraph: {
    findFirst: (args: { where: { projectId: string }; select?: any; orderBy?: any }) => Promise<{
      id: string;
      symbolCount: number;
      edgeCount: number;
      languageStats: string;
      lastIndexedAt: Date | null;
      commitSha: string | null;
    } | null>;
  };
  codeSymbol: {
    findMany: (args: any) => Promise<
      Array<{
        id: string;
        qualifiedName: string;
        kind: string;
        filePath: string;
        language: string;
        startLine: number;
      }>
    >;
  };
  codeEdge: {
    groupBy: (args: any) => Promise<
      Array<{
        toSymbolId: string | null;
        _count: { _all: number };
      }>
    >;
    findMany: (args: any) => Promise<
      Array<{
        fromSymbolId: string;
        toSymbolId: string | null;
        kind: string;
      }>
    >;
  };
  finding: {
    findMany: (args: any) => Promise<
      Array<{
        body: string;
        category: string;
        symbolId: string | null;
      }>
    >;
  };
  project: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      name: string;
      slug: string;
    } | null>;
  };
}

const ENTRY_POINT_PATTERNS = [
  /(^|\/)bin\//,
  /(^|\/)cmd\//,
  /(^|\/)src\/index\.[^/]+$/,
  /(^|\/)src\/main\.[^/]+$/,
  /\/server\.[^/]+$/,
  /\/cli\.[^/]+$/,
];

/**
 * #1371 — the patterns above are all JS/Go/Python, so every Java project
 * reported "0 entry points" — including a Spring Boot WAR with a dispatcher
 * servlet and three Quartz jobs.
 *
 * `CodeSymbol` carries no annotation metadata (see the model: kind, name,
 * qualifiedName, filePath, language, startLine), so `@SpringBootApplication` and
 * `WebApplicationInitializer` cannot be matched directly. They are matched
 * through the file-naming conventions those annotations are bound to, which is
 * how the classes are named in practice, plus an exact `main` method match that
 * needs no convention at all.
 */
const JAVA_ENTRY_POINT_FILE_PATTERNS = [
  /(^|\/)[A-Z][A-Za-z0-9_]*Application\.java$/, // @SpringBootApplication
  /(^|\/)[A-Z][A-Za-z0-9_]*Initializer\.java$/, // WebApplicationInitializer
  /(^|\/)[A-Z][A-Za-z0-9_]*Servlet\.java$/, // servlet registration
  /(^|\/)Main\.java$/,
];

/** The trailing identifier of `a/b.java::Foo.bar` — `bar`. */
function simpleSymbolName(symbol: { name?: string; qualifiedName: string }): string {
  if (symbol.name) return symbol.name;
  const tail = symbol.qualifiedName.split("::").pop() ?? symbol.qualifiedName;
  return tail.split(".").pop() ?? tail;
}

/**
 * True when a symbol looks like a Java entry point. Exported so the rule is
 * testable without a database.
 */
export function isJavaEntryPoint(symbol: {
  name?: string;
  qualifiedName: string;
  filePath: string;
  language: string;
}): boolean {
  if (symbol.language !== "java") return false;
  // `public static void main(String[])` — the unambiguous case.
  if (simpleSymbolName(symbol) === "main") return true;
  return JAVA_ENTRY_POINT_FILE_PATTERNS.some((p) => p.test(symbol.filePath));
}

const TOP_GOD_NODES = 20;
const TOP_ENTRY_POINTS = 10;
const TOP_RATIONALE_SOURCES = 5;
const SUMMARY_WORD_CAP = 500;

export interface GenerateOverviewResult {
  /** The full markdown document. */
  markdown: string;
  /** Counts emitted into the summary line. */
  stats: {
    symbolCount: number;
    edgeCount: number;
    godNodeCount: number;
    entryPointCount: number;
    languages: Array<{ language: string; count: number }>;
  };
}

export class OverviewError extends Error {
  readonly code: "NO_GRAPH" | "NO_PROJECT";
  constructor(code: "NO_GRAPH" | "NO_PROJECT", message: string) {
    super(message);
    this.code = code;
    this.name = "OverviewError";
  }
}

/**
 * Generate the markdown overview for a project. Throws `OverviewError` with
 * code `NO_PROJECT` (project missing) or `NO_GRAPH` (no CodeGraph row yet).
 *
 * Determinism guarantee: given the same DB state, two consecutive calls
 * produce byte-identical output. Achieved by:
 *  - explicit secondary sort by `qualifiedName` ASC on every list,
 *  - rationale findings ordered by inbound-edge-count DESC then symbolId ASC,
 *  - timestamp-free output (regenerated-at is stored on the Project row, not
 *    interpolated into the markdown body).
 */
export async function generateOverview(
  prisma: OverviewPrismaShape,
  projectId: string,
): Promise<GenerateOverviewResult> {
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new OverviewError("NO_PROJECT", `Project ${projectId} not found`);

  const graph = await prisma.codeGraph.findFirst({
    where: { projectId },
    orderBy: { updatedAt: "desc" },
  });
  if (!graph || graph.symbolCount === 0) {
    throw new OverviewError(
      "NO_GRAPH",
      `Project ${projectId} has no ingested CodeGraph data. Run the repo-ingest pipeline first.`,
    );
  }

  const inboundCounts = await prisma.codeEdge.groupBy({
    by: ["toSymbolId"],
    where: {
      projectId,
      kind: { in: ["calls", "references"] },
      toSymbolId: { not: null },
    },
    _count: { _all: true },
  });

  // Map symbolId -> inbound count.
  const inboundBySymbol = new Map<string, number>();
  for (const row of inboundCounts) {
    if (row.toSymbolId) inboundBySymbol.set(row.toSymbolId, row._count._all);
  }

  // ── Top-20 god-nodes ────────────────────────────────────────────────────
  const godNodeIds = Array.from(inboundBySymbol.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, TOP_GOD_NODES)
    .map(([id]) => id);

  const godNodeRows = godNodeIds.length
    ? await prisma.codeSymbol.findMany({
        where: { id: { in: godNodeIds } },
        select: {
          id: true,
          qualifiedName: true,
          kind: true,
          filePath: true,
          language: true,
          startLine: true,
        },
      })
    : [];
  // Re-attach the inbound count and sort deterministically.
  const godNodes = godNodeRows
    .map((s) => ({ ...s, inDegree: inboundBySymbol.get(s.id) ?? 0 }))
    .sort((a, b) => {
      if (b.inDegree !== a.inDegree) return b.inDegree - a.inDegree;
      return a.qualifiedName.localeCompare(b.qualifiedName);
    });

  // ── Top-10 entry points ────────────────────────────────────────────────
  const inboundCallTargetIds = await prisma.codeEdge.groupBy({
    by: ["toSymbolId"],
    where: { projectId, kind: "calls", toSymbolId: { not: null } },
    _count: { _all: true },
  });
  const calledIds = new Set<string>();
  for (const row of inboundCallTargetIds) if (row.toSymbolId) calledIds.add(row.toSymbolId);

  const candidateEntryPoints = await prisma.codeSymbol.findMany({
    where: {
      projectId,
      kind: { in: ["function", "method"] },
    },
    select: {
      id: true,
      qualifiedName: true,
      kind: true,
      filePath: true,
      language: true,
      startLine: true,
    },
  });
  const entryPoints = candidateEntryPoints
    .filter((s) => !calledIds.has(s.id))
    .filter((s) => ENTRY_POINT_PATTERNS.some((p) => p.test(s.filePath)) || isJavaEntryPoint(s))
    .sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName))
    .slice(0, TOP_ENTRY_POINTS);

  // ── Summary paragraph ──────────────────────────────────────────────────
  const topRationaleIds = godNodes.slice(0, TOP_RATIONALE_SOURCES).map((g) => g.id);
  const rationaleRows = topRationaleIds.length
    ? await prisma.finding.findMany({
        where: {
          category: "rationale",
          symbolId: { in: topRationaleIds },
        },
        select: { body: true, category: true, symbolId: true },
      })
    : [];

  // Order rationale findings deterministically by their parent god-node's
  // ranking. Within the same god-node, order by body for stability.
  const symbolRank = new Map<string, number>();
  godNodes.slice(0, TOP_RATIONALE_SOURCES).forEach((g, idx) => symbolRank.set(g.id, idx));
  const orderedRationale = [...rationaleRows].sort((a, b) => {
    const ra = a.symbolId
      ? (symbolRank.get(a.symbolId) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    const rb = b.symbolId
      ? (symbolRank.get(b.symbolId) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a.body.localeCompare(b.body);
  });

  const languages = parseLanguageStats(graph.languageStats);
  const primaryLanguageList = languages
    .map((l) => `${displayLanguage(l.language)}: ${l.count}`)
    .slice(0, 5)
    .join(", ");
  const summaryPrefix =
    `**${project.name}** is indexed with ${graph.symbolCount} symbols across ` +
    `${graph.edgeCount} edges` +
    (primaryLanguageList ? ` (${primaryLanguageList}).` : ".") +
    ` ${godNodes.length} god-nodes and ${entryPoints.length} entry points were detected.`;
  const summaryBody = composeSummary(summaryPrefix, orderedRationale, SUMMARY_WORD_CAP);

  // ── Render markdown ────────────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Project Overview — ${project.name}`);
  lines.push("");
  lines.push(
    "> Auto-generated from the project's AST CodeGraph. No LLM was used; every byte is reproducible from the graph.",
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(summaryBody);
  lines.push("");
  lines.push("## Top Symbols by In-Degree");
  lines.push("");
  if (godNodes.length === 0) {
    lines.push("_No inbound `calls`/`references` edges in this graph yet._");
  } else {
    lines.push("| Rank | Symbol | Kind | In-Degree | File |");
    lines.push("| ---: | --- | --- | ---: | --- |");
    godNodes.forEach((g, i) => {
      lines.push(
        `| ${i + 1} | \`${escapePipes(g.qualifiedName)}\` | ${g.kind} | ${g.inDegree} | \`${escapePipes(g.filePath)}\` |`,
      );
    });
  }
  lines.push("");
  lines.push("## Entry Points");
  lines.push("");
  if (entryPoints.length === 0) {
    lines.push(
      "_No entry-point candidates were found. (Looking for `bin/*`, `cmd/*`, `src/index.*`, `src/main.*`, `**/server.*`, `**/cli.*`, and for Java a `main` method or `*Application.java` / `*Initializer.java` / `*Servlet.java` / `Main.java`.)_",
    );
  } else {
    lines.push("| Symbol | Kind | File |");
    lines.push("| --- | --- | --- |");
    entryPoints.forEach((e) => {
      lines.push(
        `| \`${escapePipes(e.qualifiedName)}\` | ${e.kind} | \`${escapePipes(e.filePath)}\` |`,
      );
    });
  }
  lines.push("");

  return {
    markdown: lines.join("\n"),
    stats: {
      symbolCount: graph.symbolCount,
      edgeCount: graph.edgeCount,
      godNodeCount: godNodes.length,
      entryPointCount: entryPoints.length,
      languages,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function parseLanguageStats(raw: string): Array<{ language: string; count: number }> {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (!obj || typeof obj !== "object") return [];
  return Object.entries(obj)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .map(([language, count]) => ({ language, count }));
}

const LANGUAGE_DISPLAY: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript (TSX)",
  js: "JavaScript",
  jsx: "JavaScript (JSX)",
  py: "Python",
  go: "Go",
  java: "Java",
};

function displayLanguage(code: string): string {
  return LANGUAGE_DISPLAY[code] ?? code;
}

function escapePipes(value: string): string {
  return value.replace(/\|/g, "\\|");
}

/**
 * Concatenate a prefix + rationale-finding bodies into a paragraph,
 * deduplicating by normalised text and capping at `wordCap` words. Always
 * emits at least 3 sentences; when there are no rationales, fall back to
 * boilerplate so the AC's "at least 3 sentences" gate is met.
 */
export function composeSummary(
  prefix: string,
  rationales: Array<{ body: string }>,
  wordCap: number,
): string {
  const seen = new Set<string>();
  const parts: string[] = [prefix];

  for (const r of rationales) {
    const cleaned = oneLine(stripDocMarkup(r.body));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(ensureTerminalPunctuation(cleaned));
  }

  // Fallback boilerplate so the AC's 3-sentence minimum is met when there
  // are no extracted rationales.
  if (parts.length < 3) {
    parts.push(
      "Rationale extraction has not yet produced findings for the top symbols. Re-ingest the project after adding `// WHY:` / `// NOTE:` comments to surface design intent here.",
    );
    parts.push(
      "The tables below list the most-referenced symbols and the detected entry points — a useful jumping-off point for new contributors.",
    );
  }

  // Cap at word budget without breaking sentences mid-stream.
  const out: string[] = [];
  let words = 0;
  for (const p of parts) {
    const wc = p.split(/\s+/).filter(Boolean).length;
    if (words + wc > wordCap && out.length > 0) break;
    out.push(p);
    words += wc;
  }
  return out.join(" ");
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * #1371 — rationale bodies are harvested verbatim from source doc comments, so a
 * Java project splices raw Javadoc straight into user-facing summary prose:
 * `<p>`, `<ol>`, `<li>`, `{@code …}`, `@param`, `@return`, `@throws`.
 *
 * Block tags are dropped along with everything after them (they are reference
 * material, not prose), inline `{@code x}` / `{@link x}` collapse to their
 * payload, and HTML tags are removed while their text content survives. Anything
 * that is not doc markup is left exactly as written.
 */
export function stripDocMarkup(text: string): string {
  let out = text;
  // `{@code foo}` / `{@link Bar#baz}` → `foo` / `Bar#baz`.
  out = out.replace(/\{@\w+\s+([^}]*)\}/g, "$1");
  // Leading `*` column of a Javadoc block.
  out = out.replace(/^[ \t]*\*[ \t]?/gm, "");
  // Block tags run to the end of the comment — reference material, not prose.
  const blockTag = /(^|\s)@(param|return|returns|throws|exception|see|since|author|deprecated)\b/;
  const firstTag = blockTag.exec(out);
  if (firstTag) out = out.slice(0, firstTag.index);
  // Strip HTML tags but keep the text between them. Deliberately an ALLOWLIST of
  // Javadoc's HTML vocabulary: a blanket `<[a-z]...>` sweep would also eat Java
  // generics like `List<String>`, which are legitimate prose here.
  out = out.replace(HTML_TAG_RE, " ");
  return out;
}

const HTML_TAG_NAMES = [
  "p",
  "br",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "b",
  "i",
  "em",
  "strong",
  "code",
  "pre",
  "tt",
  "a",
  "table",
  "tr",
  "td",
  "th",
  "div",
  "span",
  "h1",
  "h2",
  "h3",
  "h4",
  "blockquote",
] as const;

/** `<p>`, `</ul>`, `<br/>`, `<a href="…">` — the tag, never its text content. */
const HTML_TAG_RE = new RegExp(`</?(?:${HTML_TAG_NAMES.join("|")})(?:\\s[^>]*)?/?>`, "gi");

function ensureTerminalPunctuation(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
