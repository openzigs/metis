/**
 * #2377 — whether a document scope holds any indexed source code, counted the
 * way the holistic synthesizer counts it (`rawSymbolCount` in `loadModules`).
 *
 * The Generate form asks this before a full-project or repository document so
 * it can warn that the run would end with `NoDocumentableCodeError`. The first
 * check (#2369) counted any symbol in the project. That missed two cases the
 * synthesizer fails on: a repository-scoped document on an empty repository
 * while another repository is indexed, and a project whose only symbols sit in
 * OS/archive junk (`__MACOSX/`, `._*`, `.DS_Store`), which the synthesizer
 * drops before counting.
 *
 * Every symbol query is scoped to one code graph so it walks the
 * `(codeGraphId, filePath)` index; CodeSymbol has no `(projectId, filePath)`
 * index, so a project-wide `ORDER BY filePath` would sort the project's whole
 * symbol set. The whole-project answer probes the project's graphs one by one.
 */
import { isJunkSourcePath } from "@metis/shared";
import { prisma } from "../prisma.js";
import { AppError } from "../../middleware/error-handler.js";
import { requireRepositoryGraph } from "./evidence-policy.js";

/** File paths read per query. Junk files are rare, so the first page nearly always decides. */
export const SOURCE_CODE_PAGE = 200;

type SymbolPathReader = {
  codeSymbol: {
    findMany(args: {
      where: { projectId: string; codeGraphId: string; filePath?: { gt: string } };
      select: { filePath: true };
      orderBy: { filePath: "asc" };
      take: number;
    }): Promise<Array<{ filePath: string }>>;
  };
};

type GraphReader = {
  codeGraph: {
    findMany(args: {
      where: { projectId: string };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
};

/**
 * True when the scope holds at least one symbol outside a junk path. Pages
 * through the scope's symbols by file path, skipping past each file it has
 * already judged, and stops at the first non-junk file.
 */
export async function hasIndexedSourceCode(
  where: { projectId: string; codeGraphId: string },
  db: SymbolPathReader = prisma as unknown as SymbolPathReader,
): Promise<boolean> {
  let after: string | undefined;
  for (;;) {
    const rows = await db.codeSymbol.findMany({
      where: { ...where, ...(after === undefined ? {} : { filePath: { gt: after } }) },
      select: { filePath: true },
      orderBy: { filePath: "asc" },
      take: SOURCE_CODE_PAGE,
    });
    if (rows.some((row) => !isJunkSourcePath(row.filePath))) return true;
    if (rows.length < SOURCE_CODE_PAGE) return false;
    after = rows[rows.length - 1].filePath;
  }
}

/**
 * The same answer for a document's scope: the whole project, or one
 * repository's code graph, resolved exactly as generation resolves it. A
 * repository with no code graph (not ingested yet, or not this project's) has
 * no source code.
 */
export async function scopeHasIndexedSourceCode(
  projectId: string,
  repoConnectorId?: string,
): Promise<boolean> {
  if (repoConnectorId === undefined) {
    const graphs = await (prisma as unknown as GraphReader).codeGraph.findMany({
      where: { projectId },
      select: { id: true },
    });
    for (const graph of graphs) {
      if (await hasIndexedSourceCode({ projectId, codeGraphId: graph.id })) return true;
    }
    return false;
  }
  let codeGraphId: string;
  try {
    codeGraphId = await requireRepositoryGraph(projectId, repoConnectorId);
  } catch (err) {
    if (err instanceof AppError && err.code === "REPOSITORY_GRAPH_UNAVAILABLE") return false;
    throw err;
  }
  return hasIndexedSourceCode({ projectId, codeGraphId });
}
