/**
 * `/analyze` — RAG + project-state cross-phase consistency check
 * (Issue #208). Reads spec / plan / tasks, asks the agent to flag any
 * uncovered ACs, orphan components, or contradictions, and APPENDS the
 * report to `.specify/analysis.md`.
 *
 * The artifact is append-only so the operator can see how consistency
 * has evolved over multiple `/analyze` runs without losing history.
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import {
  CONSISTENCY_SYSTEM_PROMPT,
  parseConsistencyReport,
} from "../../analysis/cross-doc-validator.js";

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
}

export interface AnalyzeResult {
  artifact: SpecKitArtifactDto;
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
  const [spec, plan, tasks] = await Promise.all([
    getArtifact(input.projectId, "spec.md"),
    getArtifact(input.projectId, "plan.md"),
    getArtifact(input.projectId, "tasks.md"),
  ]);
  if (!spec || !plan || !tasks) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_ANALYZE_INCOMPLETE",
      "Run /specify, /plan, and /tasks before /analyze",
    );
  }
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
  const existing = await getArtifact(input.projectId, "analysis.md");
  const prev = existing?.content ?? "# Spec Kit consistency reports\n";
  const block = `${REPORT_HEADER(now().toISOString())}\n${run.content.trim()}\n`;
  const next = `${prev.trimEnd()}\n${block}`;

  const artifact = await writeArtifact({
    projectId: input.projectId,
    name: "analysis.md",
    content: next,
    actorId: input.actorId ?? null,
  });

  return {
    artifact,
    verdict: parseVerdict(run.content),
    tokensUsed: run.tokensUsed,
    message: `Appended consistency report to analysis.md (v${artifact.version}).`,
  };
}
