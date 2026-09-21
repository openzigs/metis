/**
 * Opt-in domain web-research grounding for documentation generation (Issue #283
 * part c).
 *
 * Problem: business-requirements docs MANDATE domain/business narrative (e.g.
 * Acme Freight network structure, DOT compliance) that the source code legitimately
 * does not contain, so the entailment judge marks those domain claims
 * unsupported and the "Overview & Domain" section scores low (the SAS `risk-calc`
 * 20% case, post-#277).
 *
 * Fix: when the user opts in on the Generate Documentation flow, run the EXISTING
 * {@link WebResearchAugmenter} for the project's domain/overview topic and persist
 * the resulting {@link EvidenceDigest}s into `Analysis.metadata.webResearch` — the
 * SAME store {@link getLatestWebResearch} reads. The doc grounding retriever
 * already merges those digests into every section's grounding set
 * (`grounding-retrieval.ts`), so domain claims become genuinely entailed +
 * citable. No new web stack, no new storage column: this only synthesises a
 * domain "requirement" with evidence needs to feed the augmenter, then persists
 * via the existing enhancement-patch path.
 *
 * Default OFF: doc generation never calls this unless the flag is set, so there
 * are no surprise network calls or cost. Best-effort: any failure logs and
 * returns gracefully — it must NEVER fail doc generation (the doc is simply
 * produced with whatever grounding was already available).
 */
import { randomUUID } from "node:crypto";
import { createChildLogger } from "../../logger.js";
import { prisma } from "../../prisma.js";
import {
  WebResearchAugmenter,
  createSearchProvider,
} from "../../analysis/web-research-augmenter.js";
import {
  createAnalysis,
  markAnalysisCompleted,
  persistAnalysisEnhancement,
} from "../../analysis/analysis-service.js";
import type { AIProvider } from "../../ai/types.js";
import type {
  StructuredRequirement,
  WebResearchResult,
  WebSearchProvider,
} from "../../analysis/types/requirements.js";

const log = createChildLogger("docs-gen:domain-web-research");

/** A web-research augmenter surface (the part we use). Eases testing. */
export interface DomainAugmenterLike {
  augment(requirements: StructuredRequirement[], signal?: AbortSignal): Promise<WebResearchResult>;
}

export interface RunDomainWebResearchInput {
  projectId: string;
  /** The project's display name — anchors the domain query. */
  projectName: string;
  /** Optional project description — sharpens the domain topic. */
  projectDescription?: string | null;
  /** The doc title (e.g. "risk-calc Business Requirements") — adds topic signal. */
  docTitle: string;
  /** Actor id to attribute the synthetic analysis row to (audit). */
  actorId: string;
}

export interface RunDomainWebResearchDeps {
  /** Injectable augmenter (tests pass a mock — NO live network). */
  augmenter?: DomainAugmenterLike;
  /** Injectable AI provider (used to build the default augmenter). */
  provider?: AIProvider;
  /** Injectable search provider (defaults to env-configured `createSearchProvider`). */
  searchProvider?: WebSearchProvider;
  /** Best-effort abort. */
  signal?: AbortSignal;
}

/**
 * Build a single synthetic domain {@link StructuredRequirement} whose evidence
 * needs drive the augmenter toward the project's business domain. This is the
 * ONLY new logic: everything downstream (query generation, search, digesting,
 * trust scoring, proxy handling, persistence) is the existing pipeline.
 */
export function buildDomainRequirement(
  input: Pick<RunDomainWebResearchInput, "projectName" | "projectDescription" | "docTitle">,
): StructuredRequirement {
  const desc = (input.projectDescription ?? "").trim();
  const topic = [input.projectName, desc].filter((s) => s.length > 0).join(" — ");
  const need = `Business domain, industry context, regulatory framework, key actors, and standard terminology for: ${topic || input.projectName}`;
  return {
    id: `docs-domain-${randomUUID()}`,
    title: `Domain & business context for ${input.projectName}`,
    description:
      `Authoritative domain/business background for the system "${input.projectName}"` +
      (desc ? ` (${desc})` : "") +
      `. Used to ground the documentation's narrative Overview & Domain and Core ` +
      `Business Capabilities sections, which describe business context the source code ` +
      `does not itself contain.`,
    type: "assumption",
    stakeholders: [],
    priority: "should-have",
    ambiguities: [],
    evidenceNeeds: [
      {
        id: `docs-domain-need-${randomUUID()}`,
        description: need,
        domain: "business-domain",
        searchHints: [input.projectName, input.docTitle, "industry", "regulation", "glossary"]
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      },
    ],
    rawSource: `${input.projectName}\n${desc}\n${input.docTitle}`.trim(),
  };
}

/**
 * Persist web-research digests so {@link getLatestWebResearch} (and therefore the
 * doc grounding retriever) picks them up. Reuses the SAME store the analysis
 * orchestrator writes to: `Analysis.metadata.webResearch`. We attach to a
 * dedicated synthetic analysis row tagged `source: "docs-gen-domain-research"`
 * so we never clobber a real analysis run's research. That tag is listed in
 * {@link BACKGROUND_ANALYSIS_SOURCES}, so `listAnalysesForProject` filters the
 * row out of the analysis-history UI (the same mechanism that hides
 * `code-graph-ingest` rows).
 *
 * PRECEDENCE (intentional side-effect): `getLatestWebResearch` returns the
 * web research from the MOST-RECENT analysis row that carries it. Because this
 * synthetic row is freshly created here, it becomes the winner for ALL
 * subsequent doc generations on this project — including non-opt-in ones that
 * would otherwise have used a prior real analysis's (broader) web research.
 * This is accepted for #283: domain grounding is the more relevant source for
 * doc generation. Maintainers changing this should be aware the synthetic row
 * shadows real-analysis web research until a newer analysis writes its own.
 */
async function persistDomainResearch(
  input: RunDomainWebResearchInput,
  research: WebResearchResult,
): Promise<void> {
  const analysis = await createAnalysis({
    projectId: input.projectId,
    startedById: input.actorId,
    agentKeys: [],
  });
  // Tag the synthetic row so listAnalysesForProject() excludes it like other
  // non-LLM background rows, and mark it completed (it is not a running job).
  await prisma.analysis.update({
    where: { id: analysis.id },
    data: { metadata: JSON.stringify({ source: "docs-gen-domain-research" }) },
  });
  await persistAnalysisEnhancement(analysis.id, { webResearch: research });
  await markAnalysisCompleted(analysis.id, {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
}

/**
 * Run opt-in domain web research for a doc-generation request and persist the
 * digests into the grounding store. Best-effort: returns `null` on any failure
 * (logged) so doc generation proceeds ungrounded rather than failing.
 *
 * Returns the {@link WebResearchResult} on success so the caller can log/observe
 * how many digests were produced.
 */
export async function runDomainWebResearch(
  input: RunDomainWebResearchInput,
  deps: RunDomainWebResearchDeps = {},
): Promise<WebResearchResult | null> {
  try {
    const augmenter: DomainAugmenterLike =
      deps.augmenter ??
      new WebResearchAugmenter({
        // A provider is required to generate queries + digests. When none is
        // supplied (and none injected), we cannot run — bail out gracefully.
        provider: requireProvider(deps.provider),
        searchProvider: deps.searchProvider ?? createSearchProvider(),
      });

    const requirement = buildDomainRequirement(input);
    const research = await augmenter.augment([requirement], deps.signal);

    if (research.digests.length === 0) {
      // Nothing was found (e.g. stub provider offline / unconfigured). Skip the
      // persist so we don't write an empty research record that would shadow a
      // prior, richer one when getLatestWebResearch scans the recent window.
      log.info("Domain web research produced no digests; skipping persist", {
        projectId: input.projectId,
      });
      return research;
    }

    await persistDomainResearch(input, research);
    log.info("Persisted domain web research for doc grounding", {
      projectId: input.projectId,
      digests: research.digests.length,
      totalSources: research.totalSources,
    });
    return research;
  } catch (err) {
    // Best-effort: a domain-research failure must NOT fail doc generation.
    log.warn("Domain web research failed (continuing ungrounded)", {
      projectId: input.projectId,
      err: String(err),
    });
    return null;
  }
}

function requireProvider(provider: AIProvider | undefined): AIProvider {
  if (!provider) {
    throw new Error("no AI provider available for domain web research");
  }
  return provider;
}
