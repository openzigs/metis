/**
 * Issue #733 — plain-language, actionable copy for each machine-readable
 * analysis-capability degradation reason. Written for a business analyst: each
 * entry says WHAT was not analyzed and WHAT to do about it. Shared by the
 * results-page banner and the start-form hint so the wording never drifts.
 */
import type { AnalysisCapabilityReason } from "@metis/shared";

export interface CapabilityReasonCopy {
  /** Short headline naming the missing capability. */
  title: string;
  /** Concrete next step the user can take to fix it. */
  action: string;
}

export const CAPABILITY_REASON_COPY: Record<AnalysisCapabilityReason, CapabilityReasonCopy> = {
  "no-code-graph": {
    title: "Code was not deeply analyzed: no code graph has been built for this project.",
    action:
      "Build the code graph (connect a repository and run indexing) to enable agentic code analysis.",
  },
  "source-not-ingested": {
    title:
      "Repository source code has not been ingested, so code gap analysis was document-grounded only.",
    action: "Connect a repository so its source is indexed as knowledge alongside your documents.",
  },
  "agentic-unavailable-no-requirements": {
    title:
      "Agentic code investigation did not run: no requirements were extracted from your documents.",
    action:
      "Add requirement documents or new-requirements text so the code agent can trace requirement→code gaps.",
  },
  "fused-code-retrieval-disabled": {
    title: "Code-graph symbol grounding is turned off for this deployment.",
    action:
      "Ask an administrator to enable ANALYSIS_FUSED_CODE_RETRIEVAL for deeper, cited code findings.",
  },
  "schema-context-disabled": {
    title: "Live database-schema grounding is turned off for this deployment.",
    action:
      "Ask an administrator to enable ANALYSIS_SCHEMA_CONTEXT so the database agent grounds findings in your real data model.",
  },
  "quarantine-fallback-used": {
    title:
      "Some content was analyzed from unapproved (quarantined) documents because no approved knowledge was available.",
    action: "Approve the relevant documents and re-run for stronger, approved grounding.",
  },
  "repos-skipped-budget": {
    title: "Some repositories were skipped because the per-repository token budget was too low.",
    action:
      "Reduce the number of connected repositories, or analyze the skipped repositories in a separate run.",
  },
  "code-agent-failed": {
    title:
      "Code analysis failed for this run, so no code evidence was gathered — requirements are backed by documents only.",
    action: "Re-run the analysis. If it keeps failing, check the analysis logs for the code agent.",
  },
  "new-requirements-not-analyzed": {
    title:
      "Your new requirements could not be read as requirements, so they were not analyzed against the code.",
    action:
      "Re-phrase the new-requirements box as one requirement per line or paragraph (e.g. “The API must expose a health-check endpoint at /api/status”), then re-run.",
  },
  "code-agent-degraded": {
    title:
      "Code analysis was cut short and returned only partial findings — some requirements were not fully investigated in code.",
    action:
      "Re-run the analysis, or ask an administrator to raise ANALYSIS_AGENTIC_MAX_TURNS / ANALYSIS_AGENT_TOKEN_BUDGET so the code agent can finish.",
  },
  // Issue #773 — the run LOOKED healthy (the code agent completed and answered),
  // but its searches did not work. This is the reason a BA most needs to see:
  // every "not found" on such a run is unreliable, and acting on one means
  // rebuilding something you may already have.
  "code-retrieval-degraded": {
    title:
      "Code search returned little usable evidence — “not found” results are unreliable for this run.",
    action:
      "Nothing here was confirmed as missing: affected requirements are marked “Could not verify”, not as gaps. Re-run the analysis, or check that the code graph is built and up to date, before planning any work from this run.",
  },
  // Issue #777 — REDUCED DEPTH, NOT BROKEN SEARCH. The repository is indexed and the
  // code-graph search worked, so this run's verdicts stand; the agent just could not
  // open source files to read them line by line. The copy must NOT read like
  // `code-retrieval-degraded` above, or users will discard sound findings.
  // Issue #1112 (from #1101) — the run threw away words the USER typed. Every
  // other reason describes something METIS could not do; this one describes
  // something METIS discarded, so the copy names the surface that lists exactly
  // which requirements and why.
  "requirement-inputs-dropped": {
    title:
      "Some of the requirements you supplied were not analyzed — they were discarded before the agents saw them.",
    action:
      "See “Requirements you supplied” below for exactly which ones and why. Re-run with the dropped requirements in a separate, shorter submission so each one is analyzed.",
  },
  "repo-clone-unavailable": {
    title:
      "The repository is indexed but not checked out on the server, so code was analyzed from the code graph alone — without reading the source files.",
    action:
      "Findings from this run are still grounded in the code graph. For deeper, line-level evidence, re-sync the repository connector so a working copy is available, then re-run.",
  },
};
