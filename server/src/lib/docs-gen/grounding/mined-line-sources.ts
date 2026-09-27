/**
 * #166 — mined rules as citable sources backed by the SOURCE LINE.
 *
 * The mined-rule inventory (#155) reaches Phase 2 inside a module's `facts:`
 * grounding source, so a claim citing `src/x.ts:42` used to be checked against
 * the facts text — the miner's summary of line 42 — rather than line 42 itself.
 * A stale or wrong summary then verified its own claim.
 *
 * This module captures, while Phase 1 has every file of a module in memory,
 * the code each mined rule points at, keyed by `file:line` and tagged with a
 * hash of the file's content, so the id names one version of the file. The
 * faithfulness judge resolves a claim's `file:line` reference through
 * {@link MinedLineIndex} and judges that claim against the code line instead
 * of the facts text.
 *
 * Pure: no I/O. The Phase-1 caller passes the file lines it already read.
 */
import { createHash } from "node:crypto";
import type { PersistedMinedRule } from "../fact-slices.js";

/** The code a mined rule cites. */
export interface MinedLineSource {
  file: string;
  /** 1-based line of the rule. */
  line: number;
  /** The cited line, plus the lines its rule's expression continues onto (at most {@link MAX_RULE_LINES}). */
  code: string;
  /** First 12 hex chars of the SHA-256 of the whole file's content. */
  fileHash: string;
}

/** Lines a multi-line rule may span from its cited line. */
const MAX_RULE_LINES = 5;

const squash = (s: string): string => s.replace(/\s+/g, "");

/**
 * The source line (and continuation lines) of every mined rule whose file was
 * read, one entry per `file:line`. A rule whose file was not read, or whose
 * line is past the end of it, has no entry — its claims keep the facts text.
 */
export function minedLineSources(
  rules: readonly PersistedMinedRule[],
  fileLines: ReadonlyMap<string, readonly string[]>,
): MinedLineSource[] {
  const hashes = new Map<string, string>();
  const out = new Map<string, MinedLineSource>();
  for (const r of rules) {
    const lines = fileLines.get(r.file);
    if (!lines || r.line < 1 || r.line > lines.length) continue;
    const key = `${r.file}:${r.line}`;
    if (out.has(key)) continue;
    let fileHash = hashes.get(r.file);
    if (fileHash === undefined) {
      fileHash = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
      hashes.set(r.file, fileHash);
    }
    // A rule whose expression runs past its first line keeps the lines it needs.
    const want = squash(r.expression);
    const code: string[] = [];
    for (let i = r.line - 1; i < lines.length && code.length < MAX_RULE_LINES; i++) {
      code.push(lines[i]);
      if (!want || squash(code.join("\n")).includes(want)) break;
    }
    if (want && !squash(code.join("\n")).includes(want)) code.length = 1;
    out.set(key, { file: r.file, line: r.line, code: code.join("\n"), fileHash });
  }
  return [...out.values()];
}

/** The grounding source id of a mined line: its file's content hash and its line. */
export function minedLineSourceId(s: Pick<MinedLineSource, "fileHash" | "line">): string {
  return `mined:${s.fileHash}:${s.line}`;
}

/** `path/to/file.ext:123` references in free text. */
const LINE_REF = /([\w./-]*\w\.[A-Za-z0-9]+):(\d+)\b/g;

/** Resolves the `file:line` references in a claim to the code they cite. */
export class MinedLineIndex {
  private readonly byKey = new Map<string, MinedLineSource>();
  private readonly byLine = new Map<number, MinedLineSource[]>();

  constructor(sources: Iterable<MinedLineSource>) {
    for (const s of sources) {
      const key = `${s.file}:${s.line}`;
      if (this.byKey.has(key)) continue;
      this.byKey.set(key, s);
      const at = this.byLine.get(s.line) ?? [];
      at.push(s);
      this.byLine.set(s.line, at);
    }
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * The mined lines `claim` cites by `file:line`. A reference matches a mined
   * rule's full path, or — when exactly one mined file ends with it at a path
   * boundary — its shorter form (`x.ts:42` for `src/x.ts:42`).
   */
  resolve(claim: string): MinedLineSource[] {
    const found: MinedLineSource[] = [];
    for (const m of claim.matchAll(LINE_REF)) {
      const [, file, lineText] = m;
      const line = Number(lineText);
      const exact = this.byKey.get(`${file}:${line}`);
      const hit =
        exact ??
        (() => {
          const tail = (this.byLine.get(line) ?? []).filter((s) => s.file.endsWith(`/${file}`));
          return tail.length === 1 ? tail[0] : undefined;
        })();
      if (hit && !found.includes(hit)) found.push(hit);
    }
    return found;
  }
}
