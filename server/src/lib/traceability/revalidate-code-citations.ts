/**
 * #1831 (epic #1827) — re-check the saved requirement→code links of a repo
 * when its new code graph completes. Deterministic: no model call, no
 * embedding, nothing but the new graph's own rows.
 *
 * Clones are depth-1, so git rename detection against the old commit is not
 * available. The new graph is the evidence instead, which also catches a move
 * within a file and line drift. For each link the graph is asked:
 *
 *   1. A link to a symbol is looked up by kind and its name WITHIN its file
 *      (the qualified name less its file-path root, `Foo::bar`), from the
 *      identity the link stored (`symbolQualifiedName`/`symbolKind`/
 *      `symbolContentHash`, #1831). A link written before that stores none,
 *      and the ingest deletes the symbol rows of every file it re-parses
 *      (`codeSymbolId` is ON DELETE SET NULL), so the ingest calls
 *      {@link captureCitedSymbolIdentity} first, while those rows still exist.
 *   2. Exactly one such symbol in the same file, with the same content hash:
 *      `fresh`, its lines (and symbol id) updated if they drifted. A different
 *      hash: `stale`, `content-changed`.
 *   3. None in the same file and exactly one elsewhere with the same hash:
 *      `moved`. The link is rewritten in place to the new file, lines and
 *      symbol, and the old location is kept in `previous*` (never a duplicate
 *      row, which is what #1825 removes). One elsewhere with a different hash:
 *      `stale`, `content-changed`.
 *   4. Otherwise (no candidate, or two or more anywhere): `stale`, with
 *      `file-missing` when the cited file is gone and `symbol-missing` when it
 *      is not. An ambiguous match is never a guess.
 *   5. A file-level link (no symbol identity): `fresh` when the file is in the
 *      graph and the cited lines are within it, else `stale` (`file-missing`,
 *      or `content-changed` when the file is now shorter than the lines). A
 *      file the ingest walked but holds no symbol for (no parser for it, or
 *      unparseable) is still in the repo: its length is unknown, never missing.
 *
 * A `manual` link is a person's statement: it is never rewritten (nor deleted)
 * here, only flagged. A verdict that would move it marks it `stale` instead,
 * and line drift leaves its lines alone.
 *
 * Scope is the repo whose graph completed, never the project: a link stamped
 * with this graph (#1830), or an unstamped one whose symbol row is in it, or —
 * when the project has this one graph only — any unstamped link. Those are
 * stamped with the graph as they are checked. A link into another repo of the
 * project is not read.
 *
 * Bounded: a fixed number of reads (the links, then the candidate symbols and
 * the files in chunks), and the writes are `updateMany` calls grouped by the
 * row update they make, so the query count grows with the number of distinct
 * outcomes (one per moved symbol), not with the number of links.
 */
import type { PrismaClient } from "@prisma/client";
import { CODE_QUALIFIED_NAME_SEPARATOR } from "../code-graph/qualified-name.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("revalidate-code-citations");

/** Values per `in` list: well under SQLite's bound-parameter limit. */
const IN_CHUNK = 500;

export type StaleReason = "file-missing" | "symbol-missing" | "content-changed";

export type RevalidatePrisma = Pick<
  PrismaClient,
  "codeGraph" | "codeSymbol" | "requirementCodeMapping"
>;

export interface RevalidateOptions {
  /**
   * Every file the ingest's walk found in the tree. A file is present when the
   * graph holds a symbol for it or the walk found it; without this, only the
   * first.
   */
  presentFiles?: ReadonlySet<string>;
}

export interface RevalidationSummary {
  checked: number;
  fresh: number;
  moved: number;
  stale: number;
  /** Distinct row updates written, each one `updateMany`. */
  writes: number;
}

interface LinkRow {
  id: string;
  source: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  symbolQualifiedName: string | null;
  symbolKind: string | null;
  symbolContentHash: string | null;
  codeSymbol: {
    codeGraphId: string;
    qualifiedName: string;
    kind: string;
    contentHash: string;
  } | null;
}

interface GraphSymbol {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  qualifiedName: string;
  kind: string;
  contentHash: string;
}

/** What a link is looked up by: the symbol's kind, its name within its file, and its hash. */
interface Identity {
  kind: string;
  local: string;
  qualifiedName: string;
  contentHash: string;
}

type Verdict =
  | { freshness: "fresh"; to?: GraphSymbol }
  | { freshness: "moved"; to: GraphSymbol }
  | { freshness: "stale"; reason: StaleReason };

const SEP = CODE_QUALIFIED_NAME_SEPARATOR;

/** A qualified name less its file-path root, or null when it has none (a module, a schema symbol). */
function localName(qualifiedName: string, filePath: string): string | null {
  const prefix = `${filePath}${SEP}`;
  return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : null;
}

/** The identity a link is checked by, or null for a file-level link. */
function identityOf(row: LinkRow, codeGraphId: string): Identity | null {
  const stored =
    row.symbolQualifiedName && row.symbolKind && row.symbolContentHash
      ? {
          qualifiedName: row.symbolQualifiedName,
          kind: row.symbolKind,
          contentHash: row.symbolContentHash,
        }
      : row.codeSymbol && row.codeSymbol.codeGraphId === codeGraphId
        ? row.codeSymbol
        : null;
  if (!stored) return null;
  const local = localName(stored.qualifiedName, row.filePath);
  // A module symbol IS its file (its qualified name is the path): a file-level link.
  if (local === null) return null;
  return { ...stored, local };
}

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) out.push(items.slice(i, i + IN_CHUNK));
  return out;
}

const candidateKey = (kind: string, local: string) => `${kind}\u0000${local}`;

/** Decide one link against the new graph. */
function verdictFor(
  row: LinkRow,
  identity: Identity | null,
  fileLength: Map<string, number>,
  candidates: Map<string, GraphSymbol[]>,
): Verdict {
  const fileLines = fileLength.get(row.filePath);
  if (!identity) {
    if (fileLines === undefined) return { freshness: "stale", reason: "file-missing" };
    if (row.endLine !== null && row.endLine > fileLines) {
      return { freshness: "stale", reason: "content-changed" };
    }
    return { freshness: "fresh" };
  }
  const all = candidates.get(candidateKey(identity.kind, identity.local)) ?? [];
  const sameFile = all.filter((c) => c.filePath === row.filePath);
  if (sameFile.length === 1) {
    const [c] = sameFile;
    if (c.contentHash !== identity.contentHash) {
      return { freshness: "stale", reason: "content-changed" };
    }
    return { freshness: "fresh", to: c };
  }
  if (sameFile.length === 0 && all.length === 1) {
    const [c] = all;
    if (c.contentHash !== identity.contentHash) {
      return { freshness: "stale", reason: "content-changed" };
    }
    // A person's link is never moved: from where it points, the symbol is gone.
    if (row.source === "manual") {
      return {
        freshness: "stale",
        reason: fileLines === undefined ? "file-missing" : "symbol-missing",
      };
    }
    return { freshness: "moved", to: c };
  }
  return {
    freshness: "stale",
    reason: fileLines === undefined ? "file-missing" : "symbol-missing",
  };
}

/**
 * The identity columns to write for `current`: only when the row does not hold
 * them already (a move, or a link written before #1831), so the unchanged links
 * of a repo share one update.
 */
function identityUpdate(
  row: LinkRow,
  current: Pick<GraphSymbol, "qualifiedName" | "kind" | "contentHash"> | null | undefined,
): Record<string, string> {
  if (
    !current ||
    (row.symbolQualifiedName === current.qualifiedName &&
      row.symbolKind === current.kind &&
      row.symbolContentHash === current.contentHash)
  ) {
    return {};
  }
  return {
    symbolQualifiedName: current.qualifiedName,
    symbolKind: current.kind,
    symbolContentHash: current.contentHash,
  };
}

/** The row update for a verdict. A manual link is only ever flagged. */
function updateFor(
  row: LinkRow,
  identity: Identity | null,
  verdict: Verdict,
  stamp: { codeGraphId: string; commitSha: string | null; validatedAt: Date },
): { kind: "fresh" | "moved" | "stale"; data: Record<string, unknown> } {
  const base = { ...stamp, freshness: verdict.freshness, staleReason: null as string | null };
  if (verdict.freshness === "stale") {
    // `commitSha` stays the commit the link last held at, so "changed since
    // commit X" names the code it was read from, not the code that broke it.
    const { commitSha: _new, ...unstamped } = base;
    return { kind: "stale", data: { ...unstamped, staleReason: verdict.reason } };
  }
  if (row.source === "manual") {
    // What it points at is left alone; the identity it was checked by is kept
    // so the next check can still find the symbol.
    return { kind: "fresh", data: { ...base, ...identityUpdate(row, identity) } };
  }
  if (verdict.freshness === "moved") {
    const to = verdict.to;
    return {
      kind: "moved",
      data: {
        ...base,
        ...identityUpdate(row, to),
        codeSymbolId: to.id,
        filePath: to.filePath,
        startLine: to.startLine,
        endLine: to.endLine,
        previousFilePath: row.filePath,
        previousStartLine: row.startLine,
        previousEndLine: row.endLine,
      },
    };
  }
  const to = verdict.to;
  const drifted =
    to !== undefined &&
    (to.id !== row.codeSymbolId || to.startLine !== row.startLine || to.endLine !== row.endLine);
  return {
    kind: "fresh",
    data: {
      ...base,
      ...identityUpdate(row, to ?? identity),
      ...(drifted ? { codeSymbolId: to.id, startLine: to.startLine, endLine: to.endLine } : {}),
    },
  };
}

/**
 * Re-validate the saved code links of the repo whose graph `codeGraphId` just
 * completed. Returns what it decided; writes only the links in that repo.
 */
export async function revalidateCodeCitations(
  prisma: RevalidatePrisma,
  codeGraphId: string,
  now: Date = new Date(),
  options: RevalidateOptions = {},
): Promise<RevalidationSummary> {
  const summary: RevalidationSummary = { checked: 0, fresh: 0, moved: 0, stale: 0, writes: 0 };
  const graph = await prisma.codeGraph.findUnique({
    where: { id: codeGraphId },
    select: { id: true, projectId: true, commitSha: true },
  });
  if (!graph) return summary;
  const graphsInProject = await prisma.codeGraph.count({ where: { projectId: graph.projectId } });

  const rows: LinkRow[] = await prisma.requirementCodeMapping.findMany({
    where: {
      projectId: graph.projectId,
      OR: [
        { codeGraphId },
        graphsInProject === 1
          ? { codeGraphId: null }
          : { codeGraphId: null, codeSymbol: { codeGraphId } },
      ],
    },
    select: {
      id: true,
      source: true,
      codeSymbolId: true,
      filePath: true,
      startLine: true,
      endLine: true,
      symbolQualifiedName: true,
      symbolKind: true,
      symbolContentHash: true,
      codeSymbol: {
        select: { codeGraphId: true, qualifiedName: true, kind: true, contentHash: true },
      },
    },
  });
  if (rows.length === 0) return summary;

  const identities = rows.map((r) => identityOf(r, codeGraphId));

  // The symbols a link could now be: same kind, same name within a file.
  const names = new Set<string>();
  const kinds = new Set<string>();
  for (const id of identities) {
    if (!id) continue;
    names.add(id.local.split(SEP).pop()!);
    kinds.add(id.kind);
  }
  const candidates = new Map<string, GraphSymbol[]>();
  for (const nameChunk of chunks([...names])) {
    const found = await prisma.codeSymbol.findMany({
      where: { codeGraphId, kind: { in: [...kinds] }, name: { in: nameChunk } },
      select: {
        id: true,
        filePath: true,
        startLine: true,
        endLine: true,
        qualifiedName: true,
        kind: true,
        contentHash: true,
      },
    });
    for (const s of found) {
      const local = localName(s.qualifiedName, s.filePath);
      if (local === null) continue;
      const key = candidateKey(s.kind, local);
      candidates.set(key, [...(candidates.get(key) ?? []), s]);
    }
  }

  // Whether each cited file is in the graph, and how long it is (its module
  // symbol spans the file; the longest symbol bounds it either way).
  const fileLength = new Map<string, number>();
  for (const fileChunk of chunks([...new Set(rows.map((r) => r.filePath))])) {
    const files = await prisma.codeSymbol.groupBy({
      by: ["filePath"],
      where: { codeGraphId, filePath: { in: fileChunk } },
      _max: { endLine: true },
    });
    for (const f of files) fileLength.set(f.filePath, f._max.endLine ?? 0);
  }
  // In the tree with no symbol to bound it: present, of unknown length.
  for (const filePath of new Set(rows.map((r) => r.filePath))) {
    if (!fileLength.has(filePath) && options.presentFiles?.has(filePath)) {
      fileLength.set(filePath, Number.POSITIVE_INFINITY);
    }
  }

  const stamp = { codeGraphId, commitSha: graph.commitSha, validatedAt: now };
  const groups = new Map<string, { data: Record<string, unknown>; ids: string[] }>();
  rows.forEach((row, i) => {
    const verdict = verdictFor(row, identities[i], fileLength, candidates);
    const { kind, data } = updateFor(row, identities[i], verdict, stamp);
    summary.checked++;
    summary[kind]++;
    const key = JSON.stringify(data);
    const group = groups.get(key) ?? { data, ids: [] };
    group.ids.push(row.id);
    groups.set(key, group);
  });

  for (const { data, ids } of groups.values()) {
    for (const idChunk of chunks(ids)) {
      await prisma.requirementCodeMapping.updateMany({
        where: { id: { in: idChunk }, projectId: graph.projectId },
        data,
      });
      summary.writes++;
    }
  }
  return summary;
}

/**
 * The ingest's first step, before it deletes a single symbol row: copy the
 * identity of the symbol each link into this graph points at onto every link
 * that does not hold one yet (a link written before #1831, or by a writer that
 * stores none). Without it, a link whose symbol's file is re-parsed loses its
 * `codeSymbolId` and would be judged as a file-level link — `fresh` while the
 * file exists, for exactly the code that changed. An unstamped link is
 * attributed to this graph as well, so re-validation still finds it.
 *
 * Never throws: returns false on a fault, and the ingest then skips
 * re-validation rather than judge links it could not capture.
 */
export async function captureCitedSymbolIdentity(
  prisma: RevalidatePrisma,
  codeGraphId: string,
): Promise<boolean> {
  try {
    const graph = await prisma.codeGraph.findUnique({
      where: { id: codeGraphId },
      select: { projectId: true },
    });
    if (!graph) return true;
    const rows = await prisma.requirementCodeMapping.findMany({
      where: {
        projectId: graph.projectId,
        codeSymbol: { codeGraphId },
        OR: [{ symbolQualifiedName: null }, { symbolKind: null }, { symbolContentHash: null }],
      },
      select: {
        id: true,
        codeGraphId: true,
        codeSymbol: { select: { qualifiedName: true, kind: true, contentHash: true } },
      },
    });
    const groups = new Map<string, { data: Record<string, unknown>; ids: string[] }>();
    for (const row of rows) {
      if (!row.codeSymbol) continue;
      const data: Record<string, unknown> = {
        symbolQualifiedName: row.codeSymbol.qualifiedName,
        symbolKind: row.codeSymbol.kind,
        symbolContentHash: row.codeSymbol.contentHash,
        ...(row.codeGraphId === null ? { codeGraphId } : {}),
      };
      const key = JSON.stringify(data);
      const group = groups.get(key) ?? { data, ids: [] };
      group.ids.push(row.id);
      groups.set(key, group);
    }
    for (const { data, ids } of groups.values()) {
      for (const idChunk of chunks(ids)) {
        await prisma.requirementCodeMapping.updateMany({
          where: { id: { in: idChunk }, projectId: graph.projectId },
          data,
        });
      }
    }
    return true;
  } catch (err) {
    log.warn("could not capture cited symbol identity; re-validation skipped", {
      codeGraphId,
      error: String(err),
    });
    return false;
  }
}

/**
 * The ingest's hook: re-validate after a graph completes, and never fail the
 * ingest that produced it — a fault leaves the links as they were.
 */
export async function revalidateCodeCitationsAfterIngest(
  prisma: RevalidatePrisma,
  codeGraphId: string,
  options: RevalidateOptions = {},
): Promise<RevalidationSummary | null> {
  try {
    const summary = await revalidateCodeCitations(prisma, codeGraphId, new Date(), options);
    if (summary.checked > 0) log.info("re-validated code links", { codeGraphId, ...summary });
    return summary;
  } catch (err) {
    log.warn("code link re-validation failed; links kept as they were", {
      codeGraphId,
      error: String(err),
    });
    return null;
  }
}
