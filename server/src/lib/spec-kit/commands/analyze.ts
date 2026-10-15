/**
 * `/analyze` — RAG + project-state cross-phase consistency check
 * (Issue #208). Reads spec / plan / tasks, asks the agent to flag any
 * uncovered ACs, orphan components, or contradictions, and APPENDS the
 * report to `.specify/analysis.md`.
 *
 * The artifact is append-only so the operator can see how consistency
 * has evolved over multiple `/analyze` runs without losing history.
 *
 * #1065 — it also reads `data-model.md` and every `contracts/*` artifact when
 * the set has them, and checks each contract operation against plan.md in code
 * (`findContractPlanContradictions`): a contract that defines an endpoint the
 * plan puts out of scope is reported whether or not the model notices.
 */
import { SpecKitArtifactError } from "../artifacts.js";
import { findContractPlanContradictions } from "../contract-check.js";
import {
  artifactKey,
  forFeature,
  projectArtifactScope,
  type ArtifactScope,
  type ScopedArtifact,
} from "../artifact-scope.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import {
  CONSISTENCY_SYSTEM_PROMPT,
  parseConsistencyReport,
} from "../../analysis/cross-doc-validator.js";
import { stampPlanSource } from "../plan-provenance.js";

/**
 * Issue #218 — the spec-kit `/analyze` system prompt is now the shared
 * cross-document consistency prompt. spec.md / plan.md / tasks.md are passed
 * as the document segments, so this command and the main analysis pipeline run
 * the same QA-lead reasoning over different corpora (no behavior regression:
 * the report sections and `## Summary` verdict are unchanged).
 */
const SYSTEM_PROMPT = CONSISTENCY_SYSTEM_PROMPT;

const REPORT_HEADER = (timestamp: string): string => `\n## /analyze run @ ${timestamp}\n`;

export interface AnalyzeInput {
  projectId: string;
  actorId?: string | null;
  sessionId?: string | null;
  /** Override the timestamp baked into the report header (tests). */
  now?: () => Date;
  deps?: RunDeps;
  /** #786 — the artifact set to read and write. Defaults to the project's `.specify/`. */
  scope?: ArtifactScope;
}

export interface AnalyzeResult {
  artifact: ScopedArtifact;
  /** Top-level verdict parsed from the agent's `## Summary` block. */
  verdict: "OK" | "WARN" | "BLOCK" | "UNKNOWN";
  tokensUsed: number;
  message: string;
}

function parseVerdict(report: string): AnalyzeResult["verdict"] {
  // Issue #218 — delegate to the shared cross-doc parser so spec-kit and the
  // pipeline interpret the `## Summary` verdict identically.
  return parseConsistencyReport(report).verdict;
}

export async function runAnalyze(input: AnalyzeInput): Promise<AnalyzeResult> {
  const scope = input.scope ?? projectArtifactScope(input.projectId);
  const [spec, plan, tasks] = await Promise.all([
    scope.get("spec.md"),
    scope.get("plan.md"),
    scope.get("tasks.md"),
  ]);
  if (!spec || !plan || !tasks) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_ANALYZE_INCOMPLETE",
      scope.kind === "feature"
        ? `Run /speckit.specify, /speckit.plan, and /speckit.tasks for ${scope.featureSlug} before /speckit.analyze`
        : "Run /specify, /plan, and /tasks before /analyze",
    );
  }
  // #1065 — the Phase 1 artifacts, when this set has them (a feature's does).
  const others = await scope.list();
  const dataModel = others.find((a) => artifactKey(a) === "data-model.md") ?? null;
  const contracts = others
    .filter((a) => artifactKey(a).startsWith("contracts/"))
    .map((a) => ({ key: artifactKey(a), content: a.content }));
  const phaseOne = [
    ...(dataModel ? [{ key: "data-model.md", content: dataModel.content, lang: "md" }] : []),
    ...contracts.map((c) => ({ ...c, lang: "yaml" })),
  ];

  const project = await loadProjectContext(input.projectId);
  const userPrompt = [
    "spec.md:",
    "```md",
    spec.content,
    "```",
    "",
    "plan.md:",
    "```md",
    plan.content,
    "```",
    "",
    "tasks.md:",
    "```md",
    tasks.content,
    "```",
    "",
    ...phaseOne.flatMap((a) => [`${a.key}:`, "```" + a.lang, a.content, "```", ""]),
    ...(phaseOne.length > 0
      ? [
          `Also check ${phaseOne.map((a) => a.key).join(", ")} against plan.md: under`,
          "`## Contradictions`, report every endpoint, entity or field they define that",
          "the plan puts out of scope or never mentions.",
          "",
        ]
      : []),
    "Run the cross-phase consistency check now.",
  ].join("\n");

  const run = await runSpecKitAgent({
    command: "analyze",
    project,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });

  const now = input.now ?? (() => new Date());
  const existing = await scope.get("analysis.md");
  const prev = existing?.content ?? "# Spec Kit consistency reports\n";
  // #1065 — the contract is checked against the plan in code, so a planted
  // contradiction is reported even when the model's report says `OK`.
  const contradictions = findContractPlanContradictions(contracts, plan.content);
  const modelVerdict = parseVerdict(run.content);
  const raised = contradictions.length > 0 && (modelVerdict === "OK" || modelVerdict === "UNKNOWN");
  const verdict = raised ? "WARN" : modelVerdict;
  const contractSection =
    contradictions.length > 0
      ? [
          "",
          "## Contract vs plan",
          "",
          "Checked in code, not by the model:",
          "",
          ...contradictions.map((c) => `- ${c}`),
          ...(raised ? ["", "The verdict of this run is raised to `WARN`."] : []),
          "",
        ].join("\n")
      : "";
  const block = `${REPORT_HEADER(now().toISOString())}\n${run.content.trim()}\n${contractSection}`;
  const next = `${prev.trimEnd()}\n${block}`;

  // #1134 — the report names the plan it checked; the last report's plan is the one stamped.
  const artifact = await scope.write(
    "analysis.md",
    stampPlanSource(next, plan.version),
    input.actorId ?? null,
  );

  const n = contradictions.length;
  const contractNote =
    n > 0
      ? ` Contract check: ${n} contradiction${n === 1 ? "" : "s"} with plan.md — ${contradictions.join(" ")}`
      : "";
  return {
    artifact,
    verdict,
    tokensUsed: run.tokensUsed,
    message: `Appended consistency report to analysis.md (v${artifact.version})${forFeature(scope)}.${contractNote}`,
  };
}
