/**
 * Epic #298 / Issue #311 — Rationale extractor.
 *
 * Consumes the `rationaleHints` produced by the parsers and persists each
 * hint as a `Finding` row with `tag='rationale'`, `derivation='extracted'`,
 * `confidence=1.0`, and (when possible) a `symbolId` linking the rationale
 * to the symbol it documents.
 *
 * Linking heuristic: a hint is associated with the FIRST symbol whose
 * `startLine` is greater than or equal to the hint's `endLine` AND lies
 * within 3 lines of the hint. Hints that do not match a symbol attach to
 * the file at module scope.
 *
 * Deduplication: a hash of `(symbolId | filePath, normalisedText)` is
 * stored on the Finding's metadata so re-ingest does not create duplicates.
 */
import { createHash } from "node:crypto";
import type { ParsedFile, ParsedSymbol, RationaleHint } from "./parsers.js";

export interface RationaleFinding {
  /** Maps to `Finding.tag`. Always `"rationale"` or `"rationale-todo"`. */
  tag: "rationale" | "rationale-todo";
  title: string;
  description: string;
  /** SHA256 of normalised text — stored to dedupe re-runs. */
  contentHash: string;
  /** Resolved symbol qualified name, or null when attached to file scope. */
  symbolQualifiedName: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
  /** Hint type — copied verbatim into Finding.metadata. */
  hintTag: RationaleHint["tag"];
}

const TODO_TAGS = new Set<RationaleHint["tag"]>(["TODO", "HACK"]);

const normalise = (text: string): string => text.replace(/\s+/g, " ").trim().toLowerCase();
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export function extractRationale(parsed: ParsedFile): RationaleFinding[] {
  if (parsed.rationaleHints.length === 0) return [];

  // Symbol lookup sorted by startLine ascending so we can binary-search by line.
  const symbolsByLine = parsed.symbols
    .filter((s) => s.kind !== "module")
    .slice()
    .sort((a, b) => a.startLine - b.startLine);

  const findings: RationaleFinding[] = [];
  // Per-file dedupe set. Same content under same symbol → one finding.
  const seen = new Set<string>();

  for (const hint of parsed.rationaleHints) {
    const linkedSymbol = findNearestSymbol(symbolsByLine, hint);
    const tag: RationaleFinding["tag"] = TODO_TAGS.has(hint.tag) ? "rationale-todo" : "rationale";
    const title = buildTitle(hint, linkedSymbol);
    const description = hint.text;
    const dedupeKey = `${linkedSymbol?.qualifiedName ?? parsed.filePath}|${normalise(description)}`;
    const contentHash = sha(dedupeKey);
    if (seen.has(contentHash)) continue;
    seen.add(contentHash);
    findings.push({
      tag,
      title,
      description,
      contentHash,
      symbolQualifiedName: linkedSymbol?.qualifiedName ?? null,
      filePath: parsed.filePath,
      startLine: hint.startLine,
      endLine: hint.endLine,
      hintTag: hint.tag,
    });
  }

  return findings;
}

function findNearestSymbol(
  symbolsByLine: ParsedSymbol[],
  hint: RationaleHint,
): ParsedSymbol | null {
  // Closest symbol that starts on or AFTER the hint's end line, within 3 lines.
  for (const sym of symbolsByLine) {
    if (sym.startLine >= hint.endLine && sym.startLine - hint.endLine <= 3) {
      return sym;
    }
  }
  // Fallback: if the hint lies INSIDE a symbol body (e.g. JSDoc block above a
  // nested function), pick the smallest enclosing symbol.
  let enclosing: ParsedSymbol | null = null;
  let enclosingSize = Number.POSITIVE_INFINITY;
  for (const sym of symbolsByLine) {
    if (hint.startLine >= sym.startLine && hint.endLine <= sym.endLine) {
      const size = sym.endLine - sym.startLine;
      if (size < enclosingSize) {
        enclosing = sym;
        enclosingSize = size;
      }
    }
  }
  return enclosing;
}

function buildTitle(hint: RationaleHint, sym: ParsedSymbol | null): string {
  const subject = sym ? sym.name : "file";
  const tag = hint.tag;
  // Truncate to a reasonable headline length.
  const text = hint.text.replace(/\s+/g, " ").trim();
  const summary = text.length > 80 ? `${text.slice(0, 77)}...` : text;
  if (tag === "JSDOC" || tag === "DOCSTRING") return `${tag.toLowerCase()} on ${subject}`;
  return `${tag} on ${subject}: ${summary}`;
}
