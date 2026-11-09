/**
 * #2115 — cross-project impact through the product edges of kind `api`.
 *
 * `crossProjectImpact` (#309) follows shared database objects only, so a
 * provider whose API a declared edge says another repo consumes never named
 * that consumer, and a consumer selected into the same run had its matches
 * scored on word overlap alone: a web-UI paging fix in miniflux/v2 put six
 * python-client methods at 93–100% with no caveat.
 *
 * For one impact run this reads, for every product edge with
 * `integrationKind = "api"` that touches a repo of a project the run found
 * impact in:
 *
 *   - **who provides and who consumes**, from the edge's `direction` (source
 *     side): `consumes` / `depends-on` — the source calls the target;
 *     `provides` — the target calls the source; anything else — both ways, as
 *     the portfolio engine reads an unclassified edge;
 *   - **whether the change touched the provider's API surface**: one of the
 *     provider's direct matches for the change is in an API file — a file the
 *     edge records on the provider's side, or one under an API directory
 *     ({@link isApiSurfaceFile});
 *   - when it did, the consumer is **downstream** (`consumers`), with the
 *     methods that cite the API: the consumer's own direct matches for the
 *     same change when it is in the run, else the edge's evidence;
 *   - when the provider was matched but on none of its API surface, each of
 *     the consumer's items for that change is **untouched** — the consumer
 *     reaches the change only through that API, so its matches are low
 *     confidence. A consumer item with no provider match for the change is
 *     left alone: the change may be the consumer's own.
 *
 * An untouched flag is a claim, so it needs evidence on both counts (#2120):
 *
 *   - **the provider was matched.** A provider item with no direct match (METIS
 *     could not find the code, #1762, or reached it only through callers) says
 *     nothing about where the change lands, so it flags no one: unknown, not
 *     untouched;
 *   - **the edge says who consumes.** An edge with no direction, or one read
 *     both ways (`reads` / `writes`), is walked both ways to name consumers but
 *     flags nothing: either side may be the provider, and the reverse pass
 *     would mark the real provider's own items untouched.
 *
 * A wrongly-counted API file errs toward naming a consumer, which an analyst can
 * dismiss; a missed one errs toward a false "untouched", which reads as fact.
 * So the directory list is broad (`routes`, `controllers`, `handlers`, …) and is
 * matched per word of a segment (`RestControllers`, `public_api`).
 *
 * "The same change" is one request ({@link changeKey}): a stored requirement,
 * or all the aspects extracted from the run's own text.
 *
 * AUTHZ: the caller has already been admitted to the run
 * (`loadAccessibleImpactDetail`: every run project). Edges are read only on
 * products the caller can read (`productWhere`), and a consumer project outside
 * the run is named only when the caller can open it (`readableProjectIds`);
 * one they cannot is left out, as `crossProjectImpact` leaves out a sibling.
 *
 * Read-only: no write, no LLM, no connector.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  ApiCitingMethod,
  ApiConsumerImpact,
  ApiEdgeImpactResult,
  ApiSurfaceUntouched,
  ImpactAffectedSymbolView,
  ImpactItemView,
} from "@metis/shared";
import { prisma as defaultPrisma } from "../prisma.js";

/**
 * Words of a directory name that mark a service's API: handlers, routes,
 * controllers, specs, schemas. Matched against each word of a segment.
 */
const API_DIR_WORDS = new Set([
  "api",
  "apis",
  "rest",
  "graphql",
  "grpc",
  "rpc",
  "openapi",
  "swagger",
  "endpoint",
  "endpoints",
  "route",
  "routes",
  "router",
  "routers",
  "routing",
  "controller",
  "controllers",
  "handler",
  "handlers",
  "resolver",
  "resolvers",
  "webhook",
  "webhooks",
]);

/** A spec file is API surface wherever it sits. */
const API_SPEC_FILE =
  /(^|\/)(openapi|swagger|asyncapi)[^/]*\.(ya?ml|json)$|\.(proto|graphqls?|gql)$/i;

/** How many citing methods one consumer lists, at most. */
const MAX_CITING_METHODS = 3;

/**
 * The words of one directory name: `RestControllers` → rest, controllers;
 * `public_api` → public, api; `GraphQLHandlers` → graph, ql, handlers.
 */
function dirWords(segment: string): string[] {
  return segment
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Whether `filePath` is part of a provider's API surface: a file the API edge
 * records on the provider's side, a spec file, or a file under an API
 * directory (`internal/api/entry.go`, `src/routes/users.ts`,
 * `src/RestControllers/Feed.php`). A file under a UI directory
 * (`internal/ui/pagination.go`) is not. A directory counts when its whole name
 * or one of its words is an API word, so `rapid/` or `capital.go` never count.
 */
export function isApiSurfaceFile(filePath: string, providerFiles: ReadonlySet<string>): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  if (providerFiles.has(normalized)) return true;
  if (API_SPEC_FILE.test(normalized)) return true;
  const dirs = normalized.split("/").slice(0, -1);
  return dirs.some(
    (d) => API_DIR_WORDS.has(d.toLowerCase()) || dirWords(d).some((w) => API_DIR_WORDS.has(w)),
  );
}

/** The columns of a `ProductEdge` this module reads. */
export interface ApiEdgeRow {
  id: string;
  sourceRepoId: string;
  targetRepoId: string | null;
  direction: string | null;
  origin: string;
  strength: string | null;
  sourceFile: string | null;
  targetFile: string | null;
  /** JSON `ProductEdgeEvidence[]`. */
  evidence: string;
}

export interface ApiEdgeImpactInput {
  impactAnalysisId: string;
  /** The run's items (`ImpactAnalysisDetail.items`). */
  items: readonly ImpactItemView[];
  /** API edges touching a repo of a project the run has an item for. */
  edges: readonly ApiEdgeRow[];
  /** repoConnectionId → projectId, for every repo the edges name. */
  repoProject: ReadonlyMap<string, string>;
  /** Projects the caller may see named: the run's, plus readable others. */
  readableProjectIds: ReadonlySet<string>;
  projectNames: ReadonlyMap<string, string>;
}

interface EvidenceEntry {
  filePath?: unknown;
  lineNumber?: unknown;
  repoConnectionId?: unknown;
}

function parseEvidence(raw: string): EvidenceEntry[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((e): e is EvidenceEntry => typeof e === "object" && e !== null)
      : [];
  } catch {
    return [];
  }
}

/** The files an edge records on one of its repos' side. */
function sideFiles(edge: ApiEdgeRow, repoId: string): { filePath: string; line: number | null }[] {
  const isSource = edge.sourceRepoId === repoId;
  const out: { filePath: string; line: number | null }[] = [];
  for (const e of parseEvidence(edge.evidence)) {
    if (typeof e.filePath !== "string" || e.filePath.length === 0) continue;
    // Evidence written before #1732 names no repo; it was the edge source's.
    const owner = typeof e.repoConnectionId === "string" ? e.repoConnectionId : edge.sourceRepoId;
    if (owner !== repoId) continue;
    out.push({
      filePath: e.filePath,
      line: typeof e.lineNumber === "number" ? e.lineNumber : null,
    });
  }
  const own = isSource ? edge.sourceFile : edge.targetFile;
  if (own && !out.some((f) => f.filePath === own)) out.push({ filePath: own, line: null });
  return out;
}

interface ProviderConsumerPair {
  provider: string;
  consumer: string;
  /**
   * The edge's direction says which side calls which. Only a directed pair can
   * flag a consumer item untouched: an edge read both ways cannot tell the
   * provider's own change from a consumer's (#2120).
   */
  directed: boolean;
}

/** The (provider repo, consumer repo) pairs an edge reads as. */
function providerConsumerPairs(edge: ApiEdgeRow): ProviderConsumerPair[] {
  const target = edge.targetRepoId;
  if (!target || target === edge.sourceRepoId) return [];
  if (edge.direction === "consumes" || edge.direction === "depends-on") {
    return [{ provider: target, consumer: edge.sourceRepoId, directed: true }];
  }
  if (edge.direction === "provides") {
    return [{ provider: edge.sourceRepoId, consumer: target, directed: true }];
  }
  return [
    { provider: target, consumer: edge.sourceRepoId, directed: false },
    { provider: edge.sourceRepoId, consumer: target, directed: false },
  ];
}

/**
 * One request across the run's projects: items of one request share this key.
 * A stored requirement is its own request. The changes extracted from the
 * run's pasted text or document (no requirement id) are one request split into
 * aspects — the #2105 run split "Allow updating more fields in Update Entry
 * API endpoint" from its "Currently, …" line — so they share one key, and an
 * aspect that matched no API file does not flag a consumer another aspect of
 * the same request reached.
 *
 * The trade-off, kept on purpose (#2120): a pasted document carrying several
 * unrelated changes is still one request here. One aspect touching the API then
 * keeps every consumer item of the run from being flagged untouched, and the
 * consumer's citing methods are drawn from all its text-extracted items. That
 * errs toward naming impact, never toward a false "untouched". An item records
 * no extraction id that could split the request further.
 */
function changeKey(item: ImpactItemView): string {
  return item.requirementId ? `requirement:${item.requirementId}` : "source-text";
}

/** A symbol of `repoId` — or of an unknown repo, which cannot be ruled out. */
function inRepo(symbol: ImpactAffectedSymbolView, repoId: string): boolean {
  return !symbol.repo || symbol.repo.id === repoId;
}

function directSymbols(item: ImpactItemView, repoId: string): ImpactAffectedSymbolView[] {
  return item.affectedSymbols.filter((s) => s.depth === 0 && inRepo(s, repoId));
}

/** A declared edge speaks for an analyst; prefer it over a detected twin. */
const ORIGIN_RANK: Record<string, number> = { declared: 0, overridden: 1, detected: 2 };

/**
 * The pure core: given a run's items and the API edges around its projects,
 * the consumers its changes reach and the consumer items they leave untouched.
 */
export function computeApiEdgeImpact(input: ApiEdgeImpactInput): ApiEdgeImpactResult {
  const itemsByProject = new Map<string, ImpactItemView[]>();
  for (const item of input.items) {
    const list = itemsByProject.get(item.projectId) ?? [];
    list.push(item);
    itemsByProject.set(item.projectId, list);
  }
  const nameOf = (projectId: string) => input.projectNames.get(projectId) ?? projectId;

  const consumers: ApiConsumerImpact[] = [];
  const seenConsumer = new Set<string>();
  /** consumer item id → the first provider that left it untouched. */
  const untouchedCandidates = new Map<string, ApiSurfaceUntouched>();
  /** consumer item ids some provider's change did reach through its API. */
  const reached = new Set<string>();

  const edges = [...input.edges].sort(
    (a, b) =>
      (ORIGIN_RANK[a.origin] ?? 3) - (ORIGIN_RANK[b.origin] ?? 3) || a.id.localeCompare(b.id),
  );
  for (const edge of edges) {
    for (const { provider, consumer, directed } of providerConsumerPairs(edge)) {
      const providerProjectId = input.repoProject.get(provider);
      const consumerProjectId = input.repoProject.get(consumer);
      if (!providerProjectId || !consumerProjectId) continue;
      if (providerProjectId === consumerProjectId) continue;
      if (!input.readableProjectIds.has(consumerProjectId)) continue;
      const providerItems = itemsByProject.get(providerProjectId) ?? [];
      if (providerItems.length === 0) continue;

      const providerFiles = new Set(sideFiles(edge, provider).map((f) => f.filePath));
      const consumerItems = itemsByProject.get(consumerProjectId) ?? [];

      for (const providerItem of providerItems) {
        const direct = directSymbols(providerItem, provider);
        // No direct match: where the change lands is unknown, not off the API.
        if (direct.length === 0) continue;
        const key = changeKey(providerItem);
        const sameChange = consumerItems.filter((c) => changeKey(c) === key);
        const apiSurfaceFiles = [
          ...new Set(
            direct.map((s) => s.filePath).filter((f) => isApiSurfaceFile(f, providerFiles)),
          ),
        ].sort();

        if (apiSurfaceFiles.length === 0) {
          if (!directed) continue;
          for (const c of sameChange) {
            if (untouchedCandidates.has(c.id)) continue;
            untouchedCandidates.set(c.id, {
              consumerItemId: c.id,
              consumerProjectId,
              providerProjectId,
              providerProjectName: nameOf(providerProjectId),
              edgeId: edge.id,
            });
          }
          continue;
        }

        for (const c of sameChange) reached.add(c.id);
        const dedupe = `${providerItem.id}|${consumerProjectId}`;
        if (seenConsumer.has(dedupe)) continue;
        seenConsumer.add(dedupe);
        consumers.push({
          edgeId: edge.id,
          edgeOrigin: edge.origin,
          edgeStrength: edge.strength,
          providerProjectId,
          providerProjectName: nameOf(providerProjectId),
          providerItemId: providerItem.id,
          changeTitle: providerItem.requirementTitle,
          consumerProjectId,
          consumerProjectName: nameOf(consumerProjectId),
          apiSurfaceFiles,
          citingMethods: citingMethods(sameChange, edge, consumer),
        });
      }
    }
  }

  consumers.sort(
    (a, b) =>
      a.providerProjectName.localeCompare(b.providerProjectName) ||
      (a.changeTitle ?? "").localeCompare(b.changeTitle ?? "") ||
      a.consumerProjectName.localeCompare(b.consumerProjectName),
  );
  const untouched = [...untouchedCandidates.values()]
    .filter((u) => !reached.has(u.consumerItemId))
    .sort((a, b) => a.consumerItemId.localeCompare(b.consumerItemId));
  return { impactAnalysisId: input.impactAnalysisId, consumers, untouched };
}

/**
 * The consumer's methods that cite the provider's API: its own direct matches
 * for the change, highest confidence first, when it is in the run; otherwise
 * the edge's evidence on the consumer's side.
 */
function citingMethods(
  consumerItems: readonly ImpactItemView[],
  edge: ApiEdgeRow,
  consumerRepo: string,
): ApiCitingMethod[] {
  const fromRun = consumerItems
    .flatMap((item) => directSymbols(item, consumerRepo))
    .sort((a, b) => b.confidence - a.confidence || a.qualifiedName.localeCompare(b.qualifiedName));
  const seen = new Set<string>();
  const out: ApiCitingMethod[] = [];
  for (const s of fromRun) {
    const key = `${s.filePath}|${s.qualifiedName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      qualifiedName: s.qualifiedName,
      filePath: s.filePath,
      startLine: s.startLine,
      endLine: s.endLine,
      confidence: s.confidence,
      source: "run",
    });
    if (out.length === MAX_CITING_METHODS) return out;
  }
  if (out.length > 0) return out;
  for (const f of sideFiles(edge, consumerRepo)) {
    const key = `${f.filePath}|${f.line ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      qualifiedName: null,
      filePath: f.filePath,
      startLine: f.line,
      endLine: f.line,
      confidence: null,
      source: "edge-evidence",
    });
    if (out.length === MAX_CITING_METHODS) break;
  }
  return out;
}

/** Prisma surface this module reads. */
export type ApiEdgeImpactPrisma = Pick<PrismaClient, "productEdge" | "repoConnection" | "project">;

export interface ApiEdgeImpactAccess {
  /** The subset of `projectIds` the caller can open. */
  readableProjectIds: (projectIds: string[]) => Promise<string[]>;
  /** Restricts edges to products the caller can read; undefined for an admin. */
  productWhere?: Prisma.ProductWhereInput;
}

/**
 * Load and compute {@link computeApiEdgeImpact} for a run the caller has been
 * admitted to. Three reads plus one per side: the run's repos, the API edges
 * around them, the repos and names at the other ends.
 */
export async function apiEdgeImpact(
  run: { id: string; projectIds: readonly string[]; items: readonly ImpactItemView[] },
  access: ApiEdgeImpactAccess,
  prisma: ApiEdgeImpactPrisma = defaultPrisma as unknown as ApiEdgeImpactPrisma,
): Promise<ApiEdgeImpactResult> {
  const empty: ApiEdgeImpactResult = { impactAnalysisId: run.id, consumers: [], untouched: [] };
  const impactedProjectIds = [...new Set(run.items.map((i) => i.projectId))];
  if (impactedProjectIds.length === 0) return empty;

  const runRepos = await prisma.repoConnection.findMany({
    where: { projectId: { in: impactedProjectIds } },
    select: { id: true, projectId: true },
  });
  if (runRepos.length === 0) return empty;
  const runRepoIds = runRepos.map((r) => r.id);

  const edges = (await prisma.productEdge.findMany({
    where: {
      integrationKind: "api",
      targetRepoId: { not: null },
      OR: [{ sourceRepoId: { in: runRepoIds } }, { targetRepoId: { in: runRepoIds } }],
      ...(access.productWhere ? { product: access.productWhere } : {}),
    },
    select: {
      id: true,
      sourceRepoId: true,
      targetRepoId: true,
      direction: true,
      origin: true,
      strength: true,
      sourceFile: true,
      targetFile: true,
      evidence: true,
    },
  })) as ApiEdgeRow[];
  if (edges.length === 0) return empty;

  const repoProject = new Map(runRepos.map((r) => [r.id, r.projectId]));
  const otherRepoIds = [
    ...new Set(edges.flatMap((e) => [e.sourceRepoId, e.targetRepoId ?? ""]).filter(Boolean)),
  ].filter((id) => !repoProject.has(id));
  if (otherRepoIds.length > 0) {
    const others = await prisma.repoConnection.findMany({
      where: { id: { in: otherRepoIds } },
      select: { id: true, projectId: true },
    });
    for (const r of others) repoProject.set(r.id, r.projectId);
  }

  const runProjectIds = new Set(run.projectIds);
  const outside = [...new Set(repoProject.values())].filter((id) => !runProjectIds.has(id));
  const readable = new Set([
    ...runProjectIds,
    ...(outside.length > 0 ? await access.readableProjectIds(outside) : []),
  ]);
  const named = [...new Set(repoProject.values())].filter((id) => readable.has(id));
  const projects = await prisma.project.findMany({
    where: { id: { in: named } },
    select: { id: true, name: true },
  });

  return computeApiEdgeImpact({
    impactAnalysisId: run.id,
    items: run.items,
    edges,
    repoProject,
    readableProjectIds: readable,
    projectNames: new Map(projects.map((p) => [p.id, p.name])),
  });
}
