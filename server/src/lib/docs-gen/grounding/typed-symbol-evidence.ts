import { readFile } from "node:fs/promises";
import { z } from "zod";
import { prisma } from "../../prisma.js";
import {
  createDefaultCodeSearcher,
  type CodeSearcherDeps,
} from "../../code-graph/project-code-searcher.js";
import type { FusedCodeSearcher } from "../../rag/fused-code-context.js";
import type { EvidencePolicy } from "../evidence-policy.js";
import {
  loadRepositorySources,
  repositoryPathIdentity,
  resolveSourcePath,
  type RepositorySource,
} from "../repository-sources.js";
import type { SectionGroundingRequest, SectionGroundingRetriever } from "./grounding-retrieval.js";
import {
  buildGroundingContext,
  type GroundingContext,
  type GroundingSource,
} from "./grounding-context.js";

const typedSymbolEvidenceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxSymbols: z.number().int().min(1).max(30).default(6),
  neighborDepth: z.number().int().min(0).max(2).default(1),
  maxNeighbors: z.number().int().min(0).max(30).default(6),
  maxSourceLines: z.number().int().min(1).max(400).default(80),
  contextBefore: z.number().int().min(0).max(20).default(2),
  contextAfter: z.number().int().min(0).max(20).default(2),
});

export type TypedSymbolEvidenceConfig = z.infer<typeof typedSymbolEvidenceConfigSchema>;

export interface TypedSymbolEvidenceReport {
  enabled: boolean;
  sectionsAttempted: number;
  sectionsAugmented: number;
  symbolsHydrated: number;
  neighborSymbolsHydrated: number;
  budgetExhausted: boolean;
  fallbackReason?: string;
}

interface HydratedSymbol {
  symbolId: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  codeGraphId: string;
}

export interface TypedSymbolEvidenceDeps {
  searcher: FusedCodeSearcher;
  hydrateSymbols: (
    symbolIds: string[],
    scope: { projectId: string; codeGraphId?: string },
  ) => Promise<HydratedSymbol[]>;
  hydrateNeighborSymbols: (
    symbolIds: string[],
    scope: { projectId: string; codeGraphId?: string; maxNeighbors: number; neighborDepth: number },
  ) => Promise<HydratedSymbol[]>;
  loadRepositories: typeof loadRepositorySources;
  readSourceSpan: (input: {
    repository: RepositorySource;
    symbol: HydratedSymbol;
    contextBefore: number;
    contextAfter: number;
    maxSourceLines: number;
  }) => Promise<{ text: string; linesRead: number }>;
}

export interface BuildTypedSymbolEvidenceInput {
  projectId: string;
  policy: EvidencePolicy;
  baseRetriever: SectionGroundingRetriever;
  config?: Partial<TypedSymbolEvidenceConfig>;
}

export function resolveTypedSymbolEvidenceConfig(
  input?: Partial<TypedSymbolEvidenceConfig>,
): TypedSymbolEvidenceConfig {
  return typedSymbolEvidenceConfigSchema.parse(input ?? {});
}

export function buildTypedSymbolEvidenceRetriever(
  input: BuildTypedSymbolEvidenceInput,
  deps: Partial<TypedSymbolEvidenceDeps> = {},
): { groundingForSection: SectionGroundingRetriever; report: TypedSymbolEvidenceReport } {
  const config = resolveTypedSymbolEvidenceConfig(input.config);
  const report: TypedSymbolEvidenceReport = {
    enabled: config.enabled,
    sectionsAttempted: 0,
    sectionsAugmented: 0,
    symbolsHydrated: 0,
    neighborSymbolsHydrated: 0,
    budgetExhausted: false,
  };
  if (!config.enabled) {
    return { groundingForSection: input.baseRetriever, report };
  }

  const resolved = resolveDeps(deps);
  return {
    report,
    groundingForSection: async (
      req: SectionGroundingRequest,
    ): Promise<GroundingContext | undefined> => {
      report.sectionsAttempted += 1;
      const baseline = await input.baseRetriever(req);
      try {
        const raw = await resolved.searcher.search(req.query, input.projectId, {
          limit: config.maxSymbols,
        });
        const direct = await resolved.hydrateSymbols(
          raw.map((hit) => hit.symbolId),
          {
            projectId: input.projectId,
            ...(input.policy.codeGraphId ? { codeGraphId: input.policy.codeGraphId } : {}),
          },
        );
        const filteredDirect = filterSymbolsByPolicy(direct, input.policy);
        const neighbors =
          config.neighborDepth > 0 && config.maxNeighbors > 0
            ? filterSymbolsByPolicy(
                await resolved.hydrateNeighborSymbols(
                  filteredDirect.map((symbol) => symbol.symbolId),
                  {
                    projectId: input.projectId,
                    ...(input.policy.codeGraphId ? { codeGraphId: input.policy.codeGraphId } : {}),
                    maxNeighbors: config.maxNeighbors,
                    neighborDepth: config.neighborDepth,
                  },
                ),
                input.policy,
              )
            : [];

        const repositories = await resolved.loadRepositories({
          projectId: input.projectId,
          ...(input.policy.codeGraphId ? { codeGraphId: input.policy.codeGraphId } : {}),
        });
        const directSet = new Set(filteredDirect.map((symbol) => symbol.symbolId));
        const combined = dedupeSymbols([...filteredDirect, ...neighbors]);
        const symbolSources: GroundingSource[] = [];
        let usedLines = 0;
        let addedNeighborCount = 0;

        for (const symbol of combined) {
          const repository = repositories.get(symbol.codeGraphId);
          if (!repository || !repository.root || !repository.repoConnectorId) continue;
          const span = await resolved.readSourceSpan({
            repository,
            symbol,
            contextBefore: config.contextBefore,
            contextAfter: config.contextAfter,
            maxSourceLines: config.maxSourceLines,
          });
          if (usedLines + span.linesRead > config.maxSourceLines && symbolSources.length > 0) {
            report.budgetExhausted = true;
            break;
          }
          usedLines += span.linesRead;
          symbolSources.push({
            sourceId: typedSymbolSourceId(repository, symbol),
            kind: "facts",
            label: symbol.qualifiedName,
            text: span.text,
            evidenceClass: "repository-source",
            repository: {
              repoConnectorId: repository.repoConnectorId,
              codeGraphId: repository.codeGraphId,
            },
          });
          if (!directSet.has(symbol.symbolId)) addedNeighborCount += 1;
        }

        report.symbolsHydrated += symbolSources.length;
        report.neighborSymbolsHydrated += addedNeighborCount;
        if (symbolSources.length === 0) return baseline;
        report.sectionsAugmented += 1;
        return mergeGrounding(symbolSources, baseline);
      } catch (err) {
        report.fallbackReason = err instanceof Error ? err.message : String(err);
        return baseline;
      }
    },
  };
}

function resolveDeps(deps: Partial<TypedSymbolEvidenceDeps>): TypedSymbolEvidenceDeps {
  return {
    searcher: deps.searcher ?? createDefaultCodeSearcher({} satisfies CodeSearcherDeps),
    hydrateSymbols: deps.hydrateSymbols ?? defaultHydrateSymbols,
    hydrateNeighborSymbols: deps.hydrateNeighborSymbols ?? defaultHydrateNeighborSymbols,
    loadRepositories: deps.loadRepositories ?? loadRepositorySources,
    readSourceSpan: deps.readSourceSpan ?? defaultReadSourceSpan,
  };
}

function filterSymbolsByPolicy(
  symbols: HydratedSymbol[],
  policy: EvidencePolicy,
): HydratedSymbol[] {
  return symbols.filter(
    (symbol) => !policy.codeGraphId || symbol.codeGraphId === policy.codeGraphId,
  );
}

function dedupeSymbols(symbols: HydratedSymbol[]): HydratedSymbol[] {
  const seen = new Set<string>();
  const unique: HydratedSymbol[] = [];
  for (const symbol of symbols) {
    if (seen.has(symbol.symbolId)) continue;
    seen.add(symbol.symbolId);
    unique.push(symbol);
  }
  return unique;
}

function mergeGrounding(
  symbolSources: GroundingSource[],
  baseline: GroundingContext | undefined,
): GroundingContext {
  const merged: GroundingSource[] = [];
  const sourceIds = new Set<string>();
  for (const source of [...symbolSources, ...(baseline?.sources ?? [])]) {
    if (sourceIds.has(source.sourceId)) continue;
    sourceIds.add(source.sourceId);
    merged.push(source);
  }
  if (merged.length === 0) return baseline ?? buildGroundingContext({});
  return {
    sources: merged,
    sourceIds,
    isEmpty: false,
  };
}

function typedSymbolSourceId(repository: RepositorySource, symbol: HydratedSymbol): string {
  return `facts:symbol:${encodeURIComponent(repositoryPathIdentity(repository, symbol.filePath))}:${symbol.symbolId}:${symbol.startLine}-${symbol.endLine}`;
}

async function defaultHydrateSymbols(
  symbolIds: string[],
  scope: { projectId: string; codeGraphId?: string },
): Promise<HydratedSymbol[]> {
  if (symbolIds.length === 0) return [];
  const rows = await prisma.codeSymbol.findMany({
    where: {
      projectId: scope.projectId,
      id: { in: symbolIds },
      ...(scope.codeGraphId ? { codeGraphId: scope.codeGraphId } : {}),
    },
    select: {
      id: true,
      qualifiedName: true,
      filePath: true,
      startLine: true,
      endLine: true,
      codeGraphId: true,
    },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => ({
    symbolId: row.id,
    qualifiedName: row.qualifiedName,
    filePath: row.filePath,
    startLine: row.startLine,
    endLine: row.endLine,
    codeGraphId: row.codeGraphId,
  }));
}

async function defaultHydrateNeighborSymbols(
  symbolIds: string[],
  scope: { projectId: string; codeGraphId?: string; maxNeighbors: number; neighborDepth: number },
): Promise<HydratedSymbol[]> {
  if (symbolIds.length === 0 || scope.maxNeighbors === 0 || scope.neighborDepth === 0) return [];
  const seen = new Set(symbolIds);
  let frontier = [...symbolIds];
  const collected: string[] = [];
  for (let depth = 0; depth < scope.neighborDepth && frontier.length > 0; depth += 1) {
    const edges = await prisma.codeEdge.findMany({
      where: {
        projectId: scope.projectId,
        ...(scope.codeGraphId ? { codeGraphId: scope.codeGraphId } : {}),
        OR: [{ fromSymbolId: { in: frontier } }, { toSymbolId: { in: frontier } }],
      },
      select: { fromSymbolId: true, toSymbolId: true },
      orderBy: { id: "asc" },
    });
    const next: string[] = [];
    for (const edge of edges) {
      for (const candidate of [edge.fromSymbolId, edge.toSymbolId ?? undefined]) {
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        collected.push(candidate);
        next.push(candidate);
        if (collected.length >= scope.maxNeighbors) {
          return defaultHydrateSymbols(collected, scope);
        }
      }
    }
    frontier = next;
  }
  return defaultHydrateSymbols(collected, scope);
}

async function defaultReadSourceSpan(input: {
  repository: RepositorySource;
  symbol: HydratedSymbol;
  contextBefore: number;
  contextAfter: number;
  maxSourceLines: number;
}): Promise<{ text: string; linesRead: number }> {
  const abs = await resolveSourcePath(input.repository.root, input.symbol.filePath);
  const source = await readFile(abs, "utf8");
  const lines = source.split(/\r?\n/);
  const start = Math.max(1, input.symbol.startLine - input.contextBefore);
  const end = Math.min(lines.length, input.symbol.endLine + input.contextAfter);
  const snippetLines = lines.slice(start - 1, end).slice(0, input.maxSourceLines);
  return {
    text: [
      `${input.symbol.filePath}:${start}-${Math.min(end, start + snippetLines.length - 1)}`,
      ...snippetLines,
    ].join("\n"),
    linesRead: snippetLines.length,
  };
}
