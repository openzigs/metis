/**
 * COBOL code-graph parser (#160).
 *
 * Reads fixed- or free-format COBOL ({@link ./cobol-source.ts}) into the same
 * {@link ParsedFile} shape every other parser returns:
 *
 *   - every file → one `module` symbol (its qualified name is the file path);
 *   - `PROGRAM-ID. NAME.` → a `class` symbol `<file>::NAME` (a program holds
 *     data and procedures, and a documentable module needs a class-like
 *     symbol); nested programs nest by `END PROGRAM`;
 *   - `NAME SECTION.` / `NAME.` in the PROCEDURE DIVISION → `function` symbols
 *     `<file>::PROGRAM::NAME` — a paragraph header must start a sentence (the
 *     previous token is a period) and, in fixed format, sit in area A;
 *   - level-01/77 data items and `FD`/`SD` file descriptions → `type` symbols
 *     (level-88 condition names are rules, mined by {@link ./cbl-rule-miner.ts});
 *   - `PERFORM a [THRU b]` and `GO TO a` → `calls` edges from the enclosing
 *     paragraph (bound to the same-file paragraph at ingest); `CALL 'PROG'` →
 *     a `calls` edge to the program name, which binds to that program's
 *     `class` symbol when it is unique in the project; a dynamic
 *     `CALL identifier` names no program and is not recorded;
 *   - `COPY name` and `EXEC SQL INCLUDE name` → `imports` edges, resolved to a
 *     copybook file at ingest by {@link resolveCopybook}.
 *
 * Names are upper-cased: COBOL words are case-insensitive, so `perform init-para`
 * must bind to `INIT-PARA.`. One pass over the tokens: O(N) in source size.
 */
import { createHash } from "node:crypto";
import type { ParsedEdge, ParsedFile, ParsedSymbol, RationaleHint, SymbolKind } from "./parsers.js";
import { buildCodeQualifiedName, moduleQualifiedName } from "./qualified-name.js";
import { STATEMENT_VERBS, lexCobol, type CobolLine, type CobolToken } from "./cobol-source.js";

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** File extensions read as COBOL: programs (`.cbl`, `.cob`, `.cobol`) and copybooks (`.cpy`). */
export const COBOL_EXTENSIONS: readonly string[] = ["cbl", "cob", "cobol", "cpy"];

/** Words that can never be a paragraph or section name. */
const NOT_A_PARAGRAPH = new Set(["DECLARATIVES", "END", "PROCEDURE", "DIVISION", "SECTION"]);

/** Words after `PERFORM` that make it an inline PERFORM (no paragraph named). */
const INLINE_PERFORM = new Set(["UNTIL", "VARYING", "WITH", "TEST", "FOREVER", "TIMES"]);

interface OpenSymbol {
  kind: SymbolKind;
  name: string;
  qname: string;
  parent: string;
  /** 0-based start line. */
  start: number;
}

function rationaleTag(comment: string): RationaleHint["tag"] | null {
  const upper = comment.toUpperCase();
  for (const tag of ["WHY", "NOTE", "HACK", "TODO"] as const) {
    if (upper.startsWith(`${tag}:`)) return tag;
  }
  return null;
}

function collectRationale(lines: readonly CobolLine[]): RationaleHint[] {
  const hints: RationaleHint[] = [];
  lines.forEach((l, i) => {
    if (!l.comment) return;
    const tag = rationaleTag(l.comment);
    if (tag) {
      hints.push({
        startLine: i + 1,
        endLine: i + 1,
        tag,
        text: l.comment.slice(tag.length + 1).trim(),
      });
    }
  });
  return hints;
}

/** Name of a literal or word token (`'SUBPROG'` → `SUBPROG`), upper-cased. */
function nameOf(t: CobolToken | undefined): string | null {
  if (!t) return null;
  if (t.kind === "literal") {
    const inner = t.text.slice(1, -1).trim();
    return inner.length > 0 ? inner.toUpperCase() : null;
  }
  return t.kind === "word" || t.kind === "number" ? t.upper : null;
}

function parseCobolInner(filePath: string, source: string): ParsedFile {
  const { lines, tokens } = lexCobol(source);
  const physical = source.split(/\r?\n/);
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  const moduleQname = moduleQualifiedName(filePath);
  const lastLine = Math.max(0, lines.length - 1);
  symbols.push({
    kind: "module",
    name: filePath.split("/").pop() ?? filePath,
    qualifiedName: moduleQname,
    startLine: 1,
    endLine: lines.length,
    contentHash: sha256(source),
  });

  const emit = (s: OpenSymbol, end: number): void => {
    const endLine = Math.max(s.start, end);
    symbols.push({
      kind: s.kind,
      name: s.name,
      qualifiedName: s.qname,
      startLine: s.start + 1,
      endLine: endLine + 1,
      contentHash: sha256(physical.slice(s.start, endLine + 1).join("\n")),
    });
    edges.push({
      kind: "defines",
      fromQualifiedName: s.parent,
      toQualifiedName: s.qname,
      line: s.start + 1,
    });
  };

  const programs: OpenSymbol[] = [];
  let section: OpenSymbol | null = null;
  let paragraph: OpenSymbol | null = null;
  // A copybook has no divisions; one holding paragraphs is procedure code.
  const hasDivision = tokens.some(
    (t, k) => t.kind === "word" && tokens[k + 1]?.upper === "DIVISION",
  );
  let division: "identification" | "environment" | "data" | "procedure" | null = hasDivision
    ? null
    : "procedure";
  let idDivisionLine = -1;

  const container = (): string => programs[programs.length - 1]?.qname ?? moduleQname;
  const closeParagraph = (end: number): void => {
    if (paragraph) emit(paragraph, end);
    paragraph = null;
  };
  const closeSection = (end: number): void => {
    closeParagraph(end);
    if (section) emit(section, end);
    section = null;
  };
  /** The innermost open procedure symbol (paragraph, section, program, or the module). */
  const caller = (): string => paragraph?.qname ?? section?.qname ?? container();

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.kind !== "word") continue;

    // ---- divisions ----
    if (next?.upper === "DIVISION") {
      const d = t.upper;
      if (d === "IDENTIFICATION" || d === "ID") {
        idDivisionLine = t.line;
        division = "identification";
      } else if (d === "ENVIRONMENT") division = "environment";
      else if (d === "DATA") {
        division = "data";
      } else if (d === "PROCEDURE") {
        division = "procedure";
      }
      continue;
    }

    // ---- PROGRAM-ID. NAME. / END PROGRAM NAME. ----
    if (t.upper === "PROGRAM-ID") {
      let j = i + 1;
      if (tokens[j]?.kind === "period") j++;
      const name = nameOf(tokens[j]);
      if (name) {
        // The IDENTIFICATION DIVISION header just above belongs to this program.
        const start = idDivisionLine >= 0 && t.line - idDivisionLine <= 3 ? idDivisionLine : t.line;
        closeSection(start - 1);
        const parent = container();
        programs.push({
          kind: "class",
          name,
          qname: buildCodeQualifiedName(moduleQname, name),
          parent,
          start,
        });
        i = j;
      }
      continue;
    }
    if (t.upper === "END" && next?.upper === "PROGRAM") {
      closeSection(t.line);
      const program = programs.pop();
      if (program) emit(program, t.line);
      division = null;
      i++;
      continue;
    }

    // ---- COPY name / EXEC SQL INCLUDE name ----
    if (t.upper === "COPY") {
      const name = nameOf(next);
      if (name) {
        edges.push({
          kind: "imports",
          fromQualifiedName: container(),
          toQualifiedName: name,
          line: t.line + 1,
          metadata: { via: "COPY" },
        });
      }
      continue;
    }
    if (
      t.upper === "INCLUDE" &&
      tokens[i - 1]?.upper === "SQL" &&
      tokens[i - 2]?.upper === "EXEC"
    ) {
      const name = nameOf(next);
      if (name) {
        edges.push({
          kind: "imports",
          fromQualifiedName: container(),
          toQualifiedName: name,
          line: t.line + 1,
          metadata: { via: "EXEC SQL INCLUDE" },
        });
      }
      continue;
    }

    if (division !== "procedure") continue;

    // ---- section / paragraph headers ----
    const prev = tokens[i - 1];
    const startsSentence = !prev || prev.kind === "period";
    const inAreaA = !lines[t.line].fixed || t.col < 4;
    if (
      t.first &&
      startsSentence &&
      inAreaA &&
      !NOT_A_PARAGRAPH.has(t.upper) &&
      !STATEMENT_VERBS.has(t.upper) &&
      !t.upper.startsWith("END-")
    ) {
      if (next?.upper === "SECTION") {
        closeSection(t.line - 1);
        section = {
          kind: "function",
          name: t.upper,
          qname: buildCodeQualifiedName(container(), t.upper),
          parent: container(),
          start: t.line,
        };
        continue;
      }
      if (next?.kind === "period") {
        closeParagraph(t.line - 1);
        paragraph = {
          kind: "function",
          name: t.upper,
          qname: buildCodeQualifiedName(container(), t.upper),
          parent: section?.qname ?? container(),
          start: t.line,
        };
        i++;
        continue;
      }
    }

    // ---- PERFORM a [THRU b] ----
    if (t.upper === "PERFORM") {
      const target = next;
      const after = tokens[i + 2];
      if (
        target &&
        (target.kind === "word" || target.kind === "number") &&
        !INLINE_PERFORM.has(target.upper) &&
        !STATEMENT_VERBS.has(target.upper) &&
        !target.upper.startsWith("END-") &&
        after?.upper !== "TIMES"
      ) {
        edges.push({
          kind: "calls",
          fromQualifiedName: caller(),
          toQualifiedName: target.upper,
          line: t.line + 1,
          metadata: { via: "PERFORM" },
        });
        // `PERFORM a IN s` / `OF s` qualifies the paragraph by its section.
        let j = i + 2;
        if ((tokens[j]?.upper === "IN" || tokens[j]?.upper === "OF") && tokens[j + 1]) j += 2;
        if (tokens[j]?.upper === "THRU" || tokens[j]?.upper === "THROUGH") {
          const thru = tokens[j + 1];
          if (thru && (thru.kind === "word" || thru.kind === "number")) {
            edges.push({
              kind: "calls",
              fromQualifiedName: caller(),
              toQualifiedName: thru.upper,
              line: thru.line + 1,
              metadata: { via: "PERFORM THRU" },
            });
          }
        }
      }
      continue;
    }

    // ---- GO TO a [b c DEPENDING ON x] ----
    if (t.upper === "GO") {
      let j = i + 1;
      if (tokens[j]?.upper === "TO") j++;
      for (; j < tokens.length; j++) {
        const g = tokens[j];
        if (g.kind !== "word" && g.kind !== "number") break;
        if (g.upper === "DEPENDING" || STATEMENT_VERBS.has(g.upper) || g.upper.startsWith("END-"))
          break;
        edges.push({
          kind: "calls",
          fromQualifiedName: caller(),
          toQualifiedName: g.upper,
          line: g.line + 1,
          metadata: { via: "GO TO" },
        });
      }
      continue;
    }

    // ---- CALL 'PROGRAM' ----
    if (t.upper === "CALL" && next?.kind === "literal") {
      const name = nameOf(next);
      if (name) {
        edges.push({
          kind: "calls",
          fromQualifiedName: caller(),
          toQualifiedName: name,
          line: t.line + 1,
          metadata: { via: "CALL" },
        });
      }
    }
  }

  // Data items are read in a second pass, once every program's range is known.
  collectDataItems(tokens, lines.length, moduleQname, programs, emit, symbols);

  closeSection(lastLine);
  while (programs.length > 0) emit(programs.pop()!, lastLine);

  return {
    filePath,
    language: "cbl",
    symbols,
    edges,
    fileHash: sha256(source),
    rationaleHints: collectRationale(lines),
  };
}

/**
 * `FD`/`SD` file descriptions and level-01/77 data items as `type` symbols,
 * each running to the line before the next such item, section or division
 * header, or `END PROGRAM`.
 * The owning program is the innermost program whose range holds the item.
 */
function collectDataItems(
  tokens: readonly CobolToken[],
  lineCount: number,
  moduleQname: string,
  openPrograms: readonly OpenSymbol[],
  emit: (s: OpenSymbol, end: number) => void,
  symbols: readonly ParsedSymbol[],
): void {
  // Program ranges are only final once the main pass has emitted them; the
  // still-open ones end at the last line.
  const ranges = symbols
    .filter((s) => s.kind === "class")
    .map((s) => ({ qname: s.qualifiedName, start: s.startLine - 1, end: s.endLine - 1 }));
  for (const p of openPrograms) ranges.push({ qname: p.qname, start: p.start, end: lineCount - 1 });
  const ownerAt = (line: number): string => {
    let best: { qname: string; start: number; end: number } | null = null;
    for (const r of ranges) {
      if (line < r.start || line > r.end) continue;
      if (!best || r.end - r.start < best.end - best.start) best = r;
    }
    return best?.qname ?? moduleQname;
  };

  // A copybook has no divisions: its level-01/77 items are data all the same.
  const hasDivision = tokens.some(
    (t, k) => t.kind === "word" && tokens[k + 1]?.upper === "DIVISION",
  );
  let division: string | null = hasDivision ? null : "DATA";
  let open: OpenSymbol | null = null;
  const close = (end: number): void => {
    if (open) emit(open, end);
    open = null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const next = tokens[i + 1];
    if (t.kind === "word" && next?.upper === "DIVISION") {
      close(t.line - 1);
      division = t.upper;
      continue;
    }
    if (division !== "DATA" || !t.first) continue;
    let isItem = false;
    if (t.kind === "word") {
      if (t.upper === "FD" || t.upper === "SD") {
        close(t.line - 1);
        isItem = true;
      } else if (next?.upper === "SECTION" || (t.upper === "END" && next?.upper === "PROGRAM")) {
        close(t.line - 1);
      }
    } else if (t.kind === "number" && (Number(t.text) === 1 || Number(t.text) === 77)) {
      close(t.line - 1);
      isItem = true;
    }
    if (!isItem || next?.kind !== "word" || next.upper === "FILLER") continue;
    const owner = ownerAt(t.line);
    open = {
      kind: "type",
      name: next.upper,
      qname: buildCodeQualifiedName(owner, next.upper),
      parent: owner,
      start: t.line,
    };
  }
  close(lineCount - 1);
}

/**
 * Parse a COBOL program or copybook. Never throws: an internal error degrades
 * to an empty, `unparseable` result (the `parseSource` contract).
 */
export function parseCobol(filePath: string, source: string): ParsedFile {
  try {
    return parseCobolInner(filePath, source);
  } catch {
    return {
      filePath,
      language: "cbl",
      symbols: [],
      edges: [],
      fileHash: sha256(source),
      rationaleHints: [],
      unparseable: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Copybook resolution (ingest)
// ---------------------------------------------------------------------------

/** Upper-cased file stem → every COBOL file path with that stem. */
export type CopybookIndex = ReadonlyMap<string, readonly string[]>;

function stemOf(filePath: string): { dir: string; stem: string; ext: string } {
  const slash = filePath.lastIndexOf("/");
  const dir = slash === -1 ? "" : filePath.slice(0, slash);
  const base = filePath.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot === -1
    ? { dir, stem: base.toUpperCase(), ext: "" }
    : { dir, stem: base.slice(0, dot).toUpperCase(), ext: base.slice(dot + 1).toLowerCase() };
}

/** Index the COBOL files among `filePaths` by stem, for {@link resolveCopybook}. */
export function buildCopybookIndex(filePaths: Iterable<string>): CopybookIndex {
  const index = new Map<string, string[]>();
  for (const fp of filePaths) {
    const { stem, ext } = stemOf(fp);
    if (!COBOL_EXTENSIONS.includes(ext)) continue;
    const list = index.get(stem);
    if (list) list.push(fp);
    else index.set(stem, [fp]);
  }
  return index;
}

/**
 * The file a `COPY name` in `fromFile` includes: a COBOL file whose stem is
 * `name` (case-insensitive; a quoted `'dir/NAME.cpy'` uses its last segment),
 * preferring `.cpy` copybooks, then the including file's own directory. `null`
 * when there is no such file or the choice is ambiguous — a wrong binding is
 * worse than none.
 */
export function resolveCopybook(
  name: string,
  fromFile: string,
  index: CopybookIndex,
): string | null {
  const { stem } = stemOf(name.replace(/\\/g, "/"));
  const all = (index.get(stem) ?? []).filter((fp) => fp !== fromFile);
  if (all.length === 0) return null;
  const copybooks = all.filter((fp) => stemOf(fp).ext === "cpy");
  const pool = copybooks.length > 0 ? copybooks : all;
  if (pool.length === 1) return pool[0];
  const fromDir = stemOf(fromFile).dir;
  const sameDir = pool.filter((fp) => stemOf(fp).dir === fromDir);
  return sameDir.length === 1 ? sameDir[0] : null;
}
