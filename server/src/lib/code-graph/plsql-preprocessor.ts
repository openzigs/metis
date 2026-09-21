/**
 * PL/SQL DML pre-processor — Epic #881 (#892).
 *
 * sqlglot (the engine behind the `metis-sql-lineage` sidecar, see
 * {@link ../sql-lineage-client.ts}) is a SQL parser, **not a PL/SQL compiler** — it
 * cannot parse procedural blocks (upstream sqlglot issue #1356, closed
 * "not planned"). `routine-body-extractor.ts` sends a fetched routine BODY
 * verbatim to the sidecar, which works for a plain single-statement function body
 * but silently fails to resolve anything inside a real Oracle package member once
 * `DECLARE`/`BEGIN`/`IF`/`LOOP`/exception-handler scaffolding is present.
 *
 * This module is a **pure, text-only pre-processing stage** that sits in front of
 * that sidecar call: it strips PL/SQL procedural scaffolding from a package/routine
 * BODY and isolates each standalone DML statement (SELECT/INSERT/UPDATE/DELETE/
 * MERGE), tagged with the enclosing procedure/function member name, so each
 * statement string can be handed to sqlglot individually.
 *
 * SCOPE (read before wiring): this module only isolates & normalizes statement
 * TEXT — it never calls the sidecar, never touches {@link SchemaGraphWriter}, and
 * never persists an edge. Wiring `preprocessPlsqlBody`'s output through
 * `extractUsageSafe`/`persistCalls` (one sqlglot call per isolated statement, one
 * `calls` edge set per statement) plus Tier-1 cross-validation is #893's job — this
 * is the seam it consumes. Mirrors the pure-extractor / persist-time-metadata split
 * `mybatis-extractor.ts` already uses for `${}` raw substitution (#886): the pure
 * layer exposes `unresolved`-shaped facts (`memberName` + `placeholder` + `reason`
 * here), and the persist layer is expected to build the shared
 * `UnresolvedRefMetadata` marker (`unresolvedRefMetadata()` in `schema-graph.ts`)
 * from those facts exactly the way `persistMyBatisFile` does today.
 *
 * SECURITY / SAFETY CONTRACT (non-negotiable, mirrors the rest of the SQL-lineage
 * path): text-only. The body text is only ever pattern-matched and sliced — it is
 * NEVER executed, NEVER passed to a database driver, and NEVER interpolated into a
 * dynamically-constructed RegExp (every pattern below is a static literal).
 */

/** One isolated DML statement, tagged with its enclosing member. */
export interface PlsqlDmlStatement {
  /** The enclosing PROCEDURE/FUNCTION member name (`""` if it could not be
   * determined — e.g. a body with no PROCEDURE/FUNCTION header at all). */
  memberName: string;
  /** The isolated, sqlglot-ready statement text (single-line, `;`-terminated). */
  dml: string;
}

/** A construct that could not be isolated/parsed as plain DML — never dropped. */
export interface PlsqlUnresolvedStatement {
  /** The enclosing PROCEDURE/FUNCTION member name (`""` if undetermined). */
  memberName: string;
  /**
   * Raw dynamic/unparseable snippet: for `EXECUTE IMMEDIATE`, the dynamic-SQL
   * expression text that follows it; for an unparseable MERGE, the offending
   * statement text (truncated). Named `placeholder` to mirror the field
   * `mybatis-extractor.ts` produces for `${}` raw substitution (#886), so a
   * downstream persist step can build `unresolvedRefMetadata({ placeholder,
   * statementId, mapper: memberName })` the same way for every unresolved source.
   */
  placeholder: string;
  /** Why this couldn't be isolated as parseable DML. */
  reason: "execute-immediate" | "unparseable-construct";
}

export interface PlsqlPreprocessResult {
  statements: PlsqlDmlStatement[];
  unresolved: PlsqlUnresolvedStatement[];
}

const MAX_PLACEHOLDER_LENGTH = 200;

// ---- Tokens (all STATIC literal regexes — never built from a variable) ----

/** `PROCEDURE <name>` / `FUNCTION <name>` header, anywhere in the body (also
 * matches the `CREATE PROCEDURE <name>` / `CREATE FUNCTION <name>` shape a
 * standalone routine body arrives in — see `RoutineBodyFetcher`'s doc comment).
 * Since this matches `PROCEDURE`/`FUNCTION` ANYWHERE, not just right after
 * `CREATE`, there is no separate "extract a name from the CREATE line" fallback
 * regex: anything a `CREATE ... PROCEDURE/FUNCTION <name>` pattern could match,
 * this one already matches first. A body with zero matches (e.g. a raw
 * anonymous `BEGIN ... END;` block, no `CREATE`) falls back to `""` below. */
const MEMBER_HEADER_RE = /\b(?:PROCEDURE|FUNCTION)\s+([A-Za-z_][A-Za-z0-9_$#]*)/gi;

/**
 * Block/keyword tokens tracked to find member boundaries (declare/exception/end).
 * Compound closers (`END IF`/`END LOOP`/`END CASE`) are tried BEFORE the bare
 * `END` alternative so they always win at the same position. The bare `END`
 * alternative requires a `;` (optionally after a block label) immediately
 * after it — exactly {@link BARE_END_RE}'s shape — so a SQL `CASE ... END`
 * *expression* embedded in a DML statement (always followed by more clause
 * text: `FROM`, `WHERE`, `,`, `)`, never directly by `;`) can never be
 * mistaken for a PL/SQL block-closing `END` here.
 */
const BOUNDARY_TOKEN_RE =
  /\bBEGIN\b|\bEND\s+IF\b|\bEND\s+LOOP\b|\bEND\s+CASE\b|\bEND\b(?:\s+[A-Za-z_][A-Za-z0-9_$#]*)?(?=\s*;)|\bIF\b|\bLOOP\b|\bEXCEPTION\b/gi;

/**
 * Leading-only control-flow strippers, applied to ONE already semicolon-isolated
 * statement chunk at a time (never across a whole member body). Each is anchored
 * at `^` and removes exactly one control-flow header/footer from the FRONT of
 * the chunk; {@link stripLeadingControlTokens} re-applies the whole list until
 * none match, which correctly unwraps chunks with several glued headers (e.g.
 * `IF x THEN IF y THEN UPDATE ...` — no semicolon between nested headers).
 *
 * Anchoring at the front (rather than a whole-text global strip) is what keeps
 * a SQL `CASE ... WHEN ... ELSE ... END` *expression* embedded inside an
 * already-kept DML statement (e.g. `UPDATE t SET g = CASE WHEN x THEN 'A' ELSE
 * 'B' END`) intact: once a chunk's leading token is a real DML keyword, no
 * further stripping is attempted, so the CASE expression's own WHEN/THEN/ELSE/
 * END is never touched.
 */
const LEADING_NESTED_DECLARE_RE = /^DECLARE\b[\s\S]*?\bBEGIN\b\s*/i;
const LEADING_BEGIN_RE = /^BEGIN\b\s*/i;
const LEADING_END_IF_RE = /^END\s+IF\b\s*/i;
const LEADING_END_LOOP_RE = /^END\s+LOOP\b\s*/i;
const LEADING_END_CASE_RE = /^END\s+CASE\b\s*/i;
/** A whole chunk that is JUST a bare block-closing `END` (optionally labelled)
 * — a nested block's own `END;` landing as its own semicolon-delimited chunk. */
const LEADING_BARE_END_RE = /^END\b(?:\s+[A-Za-z_][A-Za-z0-9_$#]*)?\s*$/i;
const LEADING_IF_HEADER_RE = /^(?:IF|ELSIF)\b[\s\S]*?\bTHEN\b\s*/i;
const LEADING_ELSE_RE = /^ELSE\b\s*/i;
/** `FOR ... LOOP` / `WHILE ... LOOP` headers, including any inline cursor
 * subquery in a `FOR rec IN (SELECT ...) LOOP` — cursor constructs are
 * scaffolding per the strip list, so that embedded SELECT is intentionally
 * dropped along with the header, not isolated as DML. */
const LEADING_LOOP_HEADER_RE = /^(?:FOR|WHILE)\b[\s\S]*?\bLOOP\b\s*/i;
/** A basic (unconditional) `LOOP` left after {@link LEADING_LOOP_HEADER_RE}. */
const LEADING_BARE_LOOP_RE = /^LOOP\b\s*/i;

/** Applied in this order so compound closers (`END IF`/`END LOOP`/`END CASE`)
 * are tried before the bare `END` alternative at the same position. */
const LEADING_STRIP_PATTERNS: RegExp[] = [
  LEADING_NESTED_DECLARE_RE,
  LEADING_BEGIN_RE,
  LEADING_END_IF_RE,
  LEADING_END_LOOP_RE,
  LEADING_END_CASE_RE,
  LEADING_BARE_END_RE,
  LEADING_IF_HEADER_RE,
  LEADING_ELSE_RE,
  LEADING_LOOP_HEADER_RE,
  LEADING_BARE_LOOP_RE,
];

/** Statement-start classifiers. */
const DML_START_RE = /^(?:WITH|SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i;
const SELECT_LIKE_RE = /^(?:WITH|SELECT)\b/i;
const MERGE_RE = /^MERGE\b/i;
const EXEC_IMMEDIATE_RE = /^EXECUTE\s+IMMEDIATE\b/i;
const EXEC_IMMEDIATE_ARG_RE = /^EXECUTE\s+IMMEDIATE\s+([\s\S]+)$/i;

/** `SELECT ... INTO <var>[, <var>...] FROM ...` is PL/SQL-only syntax (binding
 * into local variables) that would confuse a pure SQL parser — the `INTO ...`
 * clause is dropped, leaving a plain `SELECT ... FROM ...`. Never matches
 * `INSERT INTO <table>` because that is always followed by `(`, `VALUES`, or a
 * bare `SELECT` keyword — never directly by another `FROM`. */
const SELECT_INTO_RE = /\bINTO\s+[A-Za-z_][\w$#.]*(?:\s*,\s*[A-Za-z_][\w$#.]*)*\s+(?=FROM\b)/i;

/** Oracle `MERGE ... LOG ERRORS [INTO tbl] [(tag)] [REJECT LIMIT n]` tail —
 * dropped best-effort so sqlglot sees a plain `MERGE INTO <target> ...`. */
const LOG_ERRORS_RE = /\bLOG\s+ERRORS\b[\s\S]*$/i;
/** After stripping `LOG ERRORS`, confirms a target table is still present. */
const MERGE_TARGET_RE = /\bINTO\s+[A-Za-z_]/i;

/**
 * Blank out (with a single space per character) every single-quoted string
 * literal and `--`/`/* *‍/` comment in `text`, preserving length/positions so
 * every other function in this module can find keyword/statement boundaries by
 * matching against the mask while slicing the ORIGINAL text (so string-literal
 * contents inside a kept DML statement — e.g. `WHERE name = 'BEGIN'` — are never
 * corrupted, and a `;` inside a string or comment is never treated as a
 * statement terminator).
 */
function maskStringsAndComments(text: string): string {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      out += " ";
      i++;
      while (i < n) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            out += "  ";
            i += 2;
            continue;
          }
          out += " ";
          i++;
          break;
        }
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      while (i < n && text[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        out += text[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Repeatedly strip ONE leading control-flow header/footer from the front of a
 * single statement chunk (see {@link LEADING_STRIP_PATTERNS}) until none match.
 * Matches against `masked` (so a chunk that — implausibly — starts inside a
 * blanked string/comment region never spuriously strips) and slices `text` by
 * the same length, keeping both in sync. */
function stripLeadingControlTokens(text: string, masked: string): { text: string; masked: string } {
  let curText = text;
  let curMasked = masked;
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of LEADING_STRIP_PATTERNS) {
      const m = re.exec(curMasked);
      if (m) {
        curText = curText.slice(m[0].length);
        curMasked = curMasked.slice(m[0].length);
        changed = true;
        break;
      }
    }
  }
  return { text: curText, masked: curMasked };
}

/** Split `text` on every `;` that appears in `masked` at the same position
 * (string/comment contents are already blanked out of `masked`, so a `;`
 * inside a literal — e.g. inside a dynamic `EXECUTE IMMEDIATE '...'` string —
 * never splits a statement). May include empty/whitespace-only chunks (a
 * trailing remainder, or two adjacent `;;`) — the caller ({@link collectMember})
 * already trims and skips those, so this stays a plain, unfiltered split. */
function splitBySemicolon(text: string, masked: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] === ";") {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

interface MemberHeader {
  name: string;
  /** Index right after the member name — depth-tracking starts scanning here. */
  scanStart: number;
}

function findMemberHeaders(masked: string): MemberHeader[] {
  const headers: MemberHeader[] = [];
  MEMBER_HEADER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MEMBER_HEADER_RE.exec(masked))) {
    headers.push({ name: m[1], scanStart: m.index + m[0].length });
  }
  return headers;
}

interface MemberBody {
  name: string;
  /** [declareEnd, execEnd) is the member's executable statement region — the
   * DECLARE section before it and the EXCEPTION section (if any) after it are
   * scaffolding and excluded. */
  declareEnd: number;
  execEnd: number;
}

/**
 * Depth-track from `scanStart` (bounded by `limit`, the next member header's
 * position or end-of-text) to find one member's DECLARE/executable/EXCEPTION
 * boundaries. Returns `null` when no `BEGIN` is found before `limit` (a
 * forward-declaration-only header with no body — nothing to extract).
 *
 * A single depth counter (incremented by `BEGIN`/`IF`/`LOOP`, decremented by
 * `END`/`END IF`/`END LOOP`) is sufficient to find the member-closing `END`
 * because well-formed PL/SQL always closes nested blocks in order — the
 * counter does not need to track WHICH kind of block is open, only how many
 * are. `END CASE` is intentionally treated as a no-op (see the module doc):
 * PL/SQL CASE *statements* are out of scope, and a SQL CASE *expression*
 * embedded in a kept DML statement always closes with a bare `END`, never
 * `END CASE`, so no depth corruption results from leaving CASE untracked.
 */
function scanMemberBody(
  masked: string,
  name: string,
  scanStart: number,
  limit: number,
): MemberBody | null {
  BOUNDARY_TOKEN_RE.lastIndex = scanStart;
  let depth = 0;
  let seenBegin = false;
  let declareEnd = scanStart;
  let exceptionStart = -1;
  let m: RegExpExecArray | null;
  while ((m = BOUNDARY_TOKEN_RE.exec(masked))) {
    if (m.index >= limit) break;
    // Normalize on the matched text itself (no capture group — see the regex
    // doc comment for why the bare-END alternative needs its own lookahead).
    const raw = m[0].toUpperCase().replace(/\s+/g, " ").trim();
    if (raw === "BEGIN") {
      if (!seenBegin && depth === 0) {
        declareEnd = m.index;
        seenBegin = true;
      }
      depth++;
    } else if (raw === "IF" || raw === "LOOP") {
      depth++;
    } else if (raw === "END IF" || raw === "END LOOP") {
      depth--;
    } else if (raw === "END CASE") {
      // no-op — CASE is never tracked as an opener (see doc comment above).
    } else if (raw === "EXCEPTION") {
      if (depth === 1 && exceptionStart === -1) exceptionStart = m.index;
    } else if (raw.startsWith("END")) {
      depth--;
      if (seenBegin && depth === 0) {
        return { name, declareEnd, execEnd: exceptionStart === -1 ? m.index : exceptionStart };
      }
    }
  }
  return null; // malformed / no body before the next member — nothing to extract
}

function truncatePlaceholder(text: string): string {
  return text.length > MAX_PLACEHOLDER_LENGTH
    ? `${text.slice(0, MAX_PLACEHOLDER_LENGTH)}...`
    : text;
}

function normalizeWhitespace(stmt: string): string {
  return stmt.replace(/\s+/g, " ").trim();
}

/** Classify one already-isolated statement chunk into a kept DML statement, an
 * unresolved/dynamic fact, or scaffolding to silently drop. */
function classifyChunk(
  chunk: string,
  memberName: string,
  statements: PlsqlDmlStatement[],
  unresolved: PlsqlUnresolvedStatement[],
): void {
  if (EXEC_IMMEDIATE_RE.test(chunk)) {
    const argMatch = EXEC_IMMEDIATE_ARG_RE.exec(chunk);
    const arg = argMatch ? argMatch[1].trim() : chunk;
    unresolved.push({
      memberName,
      placeholder: truncatePlaceholder(arg),
      reason: "execute-immediate",
    });
    return;
  }
  if (!DML_START_RE.test(chunk)) return; // scaffolding — assignment/call/cursor op/RAISE/... — dropped

  if (MERGE_RE.test(chunk)) {
    const stripped = normalizeWhitespace(chunk.replace(LOG_ERRORS_RE, ""));
    if (MERGE_TARGET_RE.test(stripped)) {
      statements.push({ memberName, dml: `${stripped};` });
    } else {
      unresolved.push({
        memberName,
        placeholder: truncatePlaceholder(normalizeWhitespace(chunk)),
        reason: "unparseable-construct",
      });
    }
    return;
  }

  let stmt = chunk;
  if (SELECT_LIKE_RE.test(stmt)) {
    stmt = stmt.replace(SELECT_INTO_RE, " ");
  }
  statements.push({ memberName, dml: `${normalizeWhitespace(stmt)};` });
}

/**
 * Parse a PL/SQL package/routine BODY (as returned by `fetchRoutineBody`/
 * `fetchPackageBody`, `CREATE`-prefixed) and isolate every DML statement,
 * tagged with its enclosing procedure/function member. Deterministic — same
 * input always yields the same output in the same order (member declaration
 * order, then statement order within each member).
 *
 * Text-only: never executes the body, never touches a database driver.
 */
export function preprocessPlsqlBody(body: string): PlsqlPreprocessResult {
  const statements: PlsqlDmlStatement[] = [];
  const unresolved: PlsqlUnresolvedStatement[] = [];
  if (!body || !body.trim()) return { statements, unresolved };

  const masked = maskStringsAndComments(body);
  const headers = findMemberHeaders(masked);

  if (headers.length === 0) {
    // No PROCEDURE/FUNCTION header at all (e.g. a raw anonymous block) — treat
    // the whole body as one implicit, unnamed member (see MEMBER_HEADER_RE's
    // doc comment for why there is no separate name-recovery fallback here).
    const member = scanMemberBody(masked, "", 0, masked.length);
    if (member) collectMember(body, masked, member, statements, unresolved);
    return { statements, unresolved };
  }

  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    const limit = i + 1 < headers.length ? headers[i + 1].scanStart : masked.length;
    const member = scanMemberBody(masked, header.name, header.scanStart, limit);
    if (member) collectMember(body, masked, member, statements, unresolved);
  }

  return { statements, unresolved };
}

function collectMember(
  body: string,
  masked: string,
  member: MemberBody,
  statements: PlsqlDmlStatement[],
  unresolved: PlsqlUnresolvedStatement[],
): void {
  const execText = body.slice(member.declareEnd, member.execEnd);
  const execMasked = masked.slice(member.declareEnd, member.execEnd);
  // Split into raw (unstripped) statement chunks FIRST — every leading
  // control-flow header/footer is then stripped per-chunk, never across the
  // whole member body (see {@link stripLeadingControlTokens}'s doc comment).
  for (const raw of splitBySemicolon(execText, execMasked)) {
    const chunkText = raw.trim();
    if (!chunkText) continue;
    // Re-mask the (already real, unmasked) chunk on its own — cheap, and lets
    // the leading-strip pass match safely even if a chunk implausibly began
    // inside a string/comment.
    const chunkMasked = maskStringsAndComments(chunkText);
    const residual = stripLeadingControlTokens(chunkText, chunkMasked);
    const residualText = residual.text.trim();
    if (!residualText) continue;
    classifyChunk(residualText, member.name, statements, unresolved);
  }
}
