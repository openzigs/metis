/**
 * #1755 — arm A3: the Analysis code agent's citations as impact seeds.
 *
 * "Evaluate new requirements" already localizes an analyst's text with a model:
 * the agentic code pass investigates the code with tools and cites files and
 * lines in its findings, and `seedRequirementCodeLinksFromFindings` keeps only
 * the citations whose file is in the code graph. A3 measures those citations as
 * impact seeds, three ways:
 *
 *   - `A3`  (A3-union): the normal tool set and seeds; the citations are
 *     unioned with A0's hybrid seeds through the stored-link channel (#1754),
 *     after every hybrid edit candidate, as production would union them.
 *   - `A3A` (A3-alone): the same pass; the citations alone are the files.
 *   - `A3N` (A3-nograph): FILE tools only (`list_files`, `read_file_slice` and
 *     `grep_files`), no graph or symbol search, no seeded blocks; the citations
 *     alone are the files. It says what the graph tools add.
 *   - `A3P` (A3-primitives, #2327): A3A's pass with chat's search primitives
 *     added (`search_code_symbols`'s filters, `grep_files`); the citations
 *     alone are the files. Paired with A3A, it says what the primitives add.
 *
 * The pass itself (database, clone, tools, agent loop) is injected as an
 * {@link AgentPass}, so this module is testable without a model or a database;
 * the CLI wires the materialized corpus (`agent-pass.ts`). A3 and A3A read the
 * SAME pass in a run: the first to run it pays, and the other reports that
 * pass's cost and time as its own reading's (`reusedCostUsd`), while the cap
 * counts the money once.
 *
 * Whatever the model cites, a file counts only if it resolves to the code graph
 * (the rule of `seed-code-links-from-findings.ts`), so graph resolution is 1.00
 * after the resolve step; the citations that did not resolve are counted.
 */
import { randomUUID } from "node:crypto";
import { resolveChangeSeeds, type StoredLinkRow } from "../../impact-analysis/change-seeds.js";
import { extractChangesByShape } from "../../impact-analysis/change-request.js";
import {
  corpusFileSymbols,
  createA0Arm,
  mergeSeedings,
  requirementText,
  type AgentCitation,
  type AgentPass,
  type AgentPassResult,
  type AgentToolset,
  type ArmDeps,
  type ArmOutput,
  type LocalizationArm,
  type SeedingFiles,
} from "./arm-core.js";
import { fileKey, type LocalizationCorpus, type LocalizationItem } from "./corpus.js";
import type { AgentRunStats } from "./scorer.js";

// The pass contract lives in arm-core.ts (#1810: no import cycle with arms.ts).
export type {
  AgentCitation,
  AgentPass,
  AgentPassRequest,
  AgentPassResult,
  AgentToolset,
} from "./arm-core.js";

/** A3's variants. */
export interface AgentVariant {
  id: "A3" | "A3A" | "A3N" | "A3P";
  toolset: AgentToolset;
  /** Union the citations with A0's hybrid seeds (stored-link channel), or use them alone. */
  union: boolean;
}

export const AGENT_VARIANTS: Readonly<Record<AgentVariant["id"], AgentVariant>> = {
  A3: { id: "A3", toolset: "graph", union: true },
  A3A: { id: "A3A", toolset: "graph", union: false },
  A3N: { id: "A3N", toolset: "files", union: false },
  A3P: { id: "A3P", toolset: "graph-primitives", union: false },
};

/** The arms that run an agent pass: the CLI materializes their corpus and database. */
export const AGENT_ARM_IDS: ReadonlySet<string> = new Set(Object.keys(AGENT_VARIANTS));

/** The repository files a pass cited that resolve to the graph, in first-cited order. */
export interface ResolvedCitations {
  /** Repo-relative paths. */
  files: string[];
  /** The links production would store: one per cited file and span, highest confidence kept. */
  links: StoredLinkRow[];
  /** Cited files the graph does not hold. */
  unresolvedFiles: number;
}

/**
 * The `seed-code-links-from-findings.ts` rule: a citation names code only when
 * its file is in the code graph; anything else is evidence, not code.
 */
export function resolveCitations(
  citations: readonly AgentCitation[],
  repo: string,
  graphFiles: ReadonlySet<string>,
): ResolvedCitations {
  const files: string[] = [];
  const unresolved = new Set<string>();
  const links = new Map<string, StoredLinkRow>();
  for (const c of citations) {
    if (!graphFiles.has(fileKey(repo, c.filePath))) {
      unresolved.add(c.filePath);
      continue;
    }
    if (!files.includes(c.filePath)) files.push(c.filePath);
    const key = `${c.filePath}\u0000${c.startLine ?? ""}\u0000${c.endLine ?? ""}`;
    const confidence = Math.min(1, Math.max(0, c.confidence));
    const prev = links.get(key);
    if (!prev || confidence > prev.confidence) {
      links.set(key, {
        codeSymbolId: null,
        filePath: c.filePath,
        startLine: c.startLine ?? null,
        endLine: c.endLine ?? null,
        confidence,
        source: "analysis-grounding",
      });
    }
  }
  return { files, links: [...links.values()], unresolvedFiles: unresolved.size };
}

/** A pass, and what it cost the meter, shared by the arms that read it. */
interface SharedPass {
  /** #1810 — names the pass, so a report can tell when two arms read different passes. */
  id: string;
  result: AgentPassResult;
  /** Null when the pass made an unpriced call. */
  costUsd: number | null;
  seconds: number;
}

/** One store per pass function: A3 and A3A built from the same deps share it. */
const sharedPasses = new WeakMap<AgentPass, Map<string, Promise<SharedPass>>>();

/**
 * Build an A3 variant. Needs `deps.agentPass` (the CLI's materialized pass),
 * `deps.meter` (to price a pass another arm reuses) and `deps.provider` (the
 * pass's model, named in the configuration so a resume on another model is refused).
 */
export function createAgentArm(deps: ArmDeps, variant: AgentVariant): LocalizationArm {
  const { agentPass, meter, provider } = deps;
  // #1810 — the provider is the pass's model: the configuration names it, so a
  // resume on another model is refused and the report says which model ran.
  if (!agentPass || !meter || !provider) {
    throw new Error(
      `arm ${variant.id} runs the analysis agent: it needs a materialized corpus and a live, metered provider (pnpm eval:materialize <corpus>; AI_PROVIDER and its key)`,
    );
  }
  const now = deps.now ?? Date.now;
  if (!sharedPasses.has(agentPass)) sharedPasses.set(agentPass, new Map());
  const store = sharedPasses.get(agentPass)!;
  const a0 = variant.union ? createA0Arm(deps) : null;
  const fileSymbols = new WeakMap<LocalizationCorpus, ReturnType<typeof corpusFileSymbols>>();

  /** Run the pass, or reuse the one another arm ran for this item, repository and run. */
  async function pass(
    corpus: LocalizationCorpus,
    item: LocalizationItem,
    repo: string,
    run: number,
  ): Promise<{ shared: SharedPass; reused: boolean }> {
    const key = [corpus.name, item.id, repo, run, variant.toolset].join("\u0000");
    const existing = store.get(key);
    if (existing) return { shared: await existing, reused: true };
    const started = now();
    const spent = meter!.spentUsd();
    const unpriced = meter!.unpricedCalls();
    const running = agentPass!({
      corpus: corpus.name,
      repo,
      text: requirementText(item),
      toolset: variant.toolset,
    }).then((result): SharedPass => ({
      id: randomUUID(),
      result,
      costUsd: meter!.unpricedCalls() > unpriced ? null : meter!.spentUsd() - spent,
      seconds: (now() - started) / 1000,
    }));
    store.set(key, running);
    // A failed pass is not kept: a resume runs it again.
    running.catch(() => store.delete(key));
    return { shared: await running, reused: false };
  }

  const toolsetLabel =
    variant.toolset === "graph"
      ? "assembleAgenticCodeTools (search_code_graph, search_code_symbols, search_knowledge, read_file_slice, list_files) + seeded fused / affected-code / affected-schema blocks"
      : variant.toolset === "graph-primitives"
        ? "assembleAgenticCodeTools with search_code_symbols's fileGlob/symbolKind/language filters, plus grep_files (#2327) + seeded fused / affected-code / affected-schema blocks"
        : "list_files, read_file_slice, grep_files (literal text search); no graph or symbol search, no seeded blocks";
  return {
    id: variant.id,
    label:
      `${variant.id} — the Analysis code agent's graph-resolving citations` +
      `${variant.union ? ", unioned with A0's hybrid seeds" : " alone"}` +
      `${variant.toolset === "files" ? ", file tools only (no graph)" : ""}` +
      `${variant.toolset === "graph-primitives" ? ", with chat's search primitives" : ""}` +
      ` (${provider.key}/${provider.model})`,
    configuration: {
      ...(a0 ? a0.configuration : {}),
      stage: variant.union
        ? "resolveChangeSeeds + stored-link channel fed by the agent's citations (#1754, #1755)"
        : "the agent's citations alone (#1755)",
      agentPass:
        "the orchestrator's agentic code pass: extractNewRequirementCandidates(text) as the requirements, the text as extraInstructions, buildAgenticPassPrompt, runAgentLoop at resolveAgenticMaxTurns (single pass, no escalation), one pass per repository",
      tools: toolsetLabel,
      citationRule:
        "seed-code-links-from-findings.ts: a cited file counts only when it is in the code graph",
      order: variant.union
        ? "A0's edit candidates, then the cited files (stored-link order: confidence, then path)"
        : "cited files in first-cited order (findings, then citations); round-robin across repositories",
      sharedPass:
        variant.toolset === "graph"
          ? "A3 and A3A read one pass per item, repository and run; each reports the pass's cost and time"
          : "own pass",
      provider: provider.key,
      model: provider.model,
      llm: true,
    },
    async localize(item, corpus, context): Promise<ArmOutput> {
      const run = context?.run ?? 1;
      if (!fileSymbols.has(corpus)) fileSymbols.set(corpus, corpusFileSymbols(corpus));
      const loadFileSymbols = fileSymbols.get(corpus)!;
      const seedings: SeedingFiles[] = [];
      const named: string[] = [];
      let turns = 0;
      const agent: AgentRunStats = {
        passes: 0,
        unanswered: 0,
        toolCalls: 0,
        citedFiles: 0,
        unresolvedFiles: 0,
        passGroup: variant.toolset,
        passIds: [],
      };
      let reusedCost: number | null = 0;
      let reusedSeconds = 0;
      for (const repo of corpus.manifest.repos) {
        const { shared, reused } = await pass(corpus, item, repo.name, run);
        turns += shared.result.turns;
        if (reused) {
          reusedSeconds += shared.seconds;
          reusedCost =
            reusedCost === null || shared.costUsd === null ? null : reusedCost + shared.costUsd;
        }
        const resolved = resolveCitations(shared.result.citations, repo.name, corpus.graphFiles);
        // #1810 — the counts the pass computes, for the report: the graph
        // resolution of the files kept is 1.00 by construction, so the rate
        // before the resolve step and the unanswered passes are read here.
        agent.passes += 1;
        agent.unanswered += shared.result.answered ? 0 : 1;
        agent.toolCalls += shared.result.toolCalls;
        agent.citedFiles += resolved.files.length + resolved.unresolvedFiles;
        agent.unresolvedFiles += resolved.unresolvedFiles;
        agent.passIds.push(shared.id);
        const key = (filePath: string) => fileKey(repo.name, filePath);
        named.push(...resolved.files.map(key));
        if (!variant.union) {
          seedings.push({ edit: resolved.files.map(key), other: [] });
          continue;
        }
        for (const change of extractChangesByShape(requirementText(item))) {
          const seeds = await resolveChangeSeeds({ ...change, requirementId: item.id }, repo.name, {
            searcher: deps.search.searcher,
            loadSymbols: deps.search.loadSymbols,
            loadWriterIds: deps.search.loadWriterIds,
            storedLinks: { loadLinks: async () => resolved.links, loadFileSymbols },
          });
          seedings.push({
            edit: [...new Set(seeds.editCandidates.map((m) => key(m.filePath)))],
            other: [
              ...new Set([...seeds.related, ...seeds.schemaSeeds].map((m) => key(m.filePath))),
            ],
          });
        }
      }
      return {
        ...mergeSeedings(seedings),
        llmNamedFiles: [...new Set(named)],
        agentTurns: turns,
        agent,
        ...(reusedSeconds > 0 || reusedCost !== 0
          ? { reusedCostUsd: reusedCost, reusedSeconds }
          : {}),
      };
    },
  };
}

/** A3 — citations unioned with A0's hybrid seeds (#1755). */
export function createA3Arm(deps: ArmDeps): LocalizationArm {
  return createAgentArm(deps, AGENT_VARIANTS.A3);
}

/** A3A — the same pass's citations alone (#1755). */
export function createA3AArm(deps: ArmDeps): LocalizationArm {
  return createAgentArm(deps, AGENT_VARIANTS.A3A);
}

/** A3N — file tools only, no graph, no seeds; citations alone (#1755). */
export function createA3NArm(deps: ArmDeps): LocalizationArm {
  return createAgentArm(deps, AGENT_VARIANTS.A3N);
}

/** A3P — A3A's pass with chat's search primitives; citations alone (#2327). */
export function createA3PArm(deps: ArmDeps): LocalizationArm {
  return createAgentArm(deps, AGENT_VARIANTS.A3P);
}
