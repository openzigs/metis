/**
 * `/tasks` — runs the PO agent against `.specify/spec.md` + `plan.md` and
 * writes `.specify/tasks.md` (Issue #206).
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";

/**
 * Exported for the structural-contract tests (#376) — see specify.ts.
 */
export const TASKS_SYSTEM_PROMPT = [
  "You are a Product Owner producing a Spec Kit-compatible tasks.md that",
  "downstream AI agents (analysis → requirements → code) will parse",
  "deterministically and implement one task at a time.",
  "",
  "Output Markdown ONLY. Emit a single `## Tasks` heading followed by a flat",
  "Markdown checklist — one checklist item per task, in topological order.",
  "",
  "ATOMICITY — each task MUST be a single PR-able unit of work:",
  "  - Small enough that one engineer can complete and open ONE pull request",
  "    for it (roughly a Fibonacci 1–5 of effort; split anything larger).",
  "  - Independently testable and independently reviewable.",
  "  - Do exactly one thing — never bundle unrelated changes.",
  "",
  "TRACEABILITY — every task MUST map to spec acceptance criteria:",
  "  - Give each task a stable id `T01`, `T02`, … (sequential).",
  "  - End each checklist line with the spec AC id(s) it satisfies, using the",
  "    STABLE ids from spec.md (`AC-1`, `AC-2`, …) — one or more per task.",
  "  - List dependencies on earlier tasks as `depends-on: T0x` (or omit when",
  "    none). No task may depend on a higher-numbered task.",
  "  - Collectively the tasks MUST cover every AC id in spec.md.",
  "",
  "FORMAT — use exactly this checklist shape (parseable, stable):",
  "",
  "    ## Tasks",
  "",
  "    - [ ] T01 — <atomic task title> (satisfies: AC-1) depends-on: none",
  "    - [ ] T02 — <atomic task title> (satisfies: AC-2, AC-3) depends-on: T01",
  "",
  "Leave every checkbox unchecked (`[ ]`). Output the checklist ONLY — no",
  "prose before or after.",
].join("\n");

const SYSTEM_PROMPT = TASKS_SYSTEM_PROMPT;

export interface TasksInput {
  projectId: string;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
}

export interface TasksResult {
  artifact: SpecKitArtifactDto;
  tokensUsed: number;
  message: string;
}

export async function runTasks(input: TasksInput): Promise<TasksResult> {
  const [spec, plan] = await Promise.all([
    getArtifact(input.projectId, "spec.md"),
    getArtifact(input.projectId, "plan.md"),
  ]);
  if (!spec || spec.content.trim().length === 0) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_TASKS_NEEDS_SPEC",
      "Run /specify before /tasks — no spec.md found",
    );
  }
  if (!plan || plan.content.trim().length === 0) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_TASKS_NEEDS_PLAN",
      "Run /plan before /tasks — no plan.md found",
    );
  }
  const project = await loadProjectContext(input.projectId);
  const userPrompt = [
    `Project: ${project.name}`,
    "",
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
    "Produce tasks.md per the system instructions.",
  ].join("\n");

  const run = await runSpecKitAgent({
    command: "tasks",
    project,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });

  const artifact = await writeArtifact({
    projectId: input.projectId,
    name: "tasks.md",
    content: run.content,
    actorId: input.actorId ?? null,
  });

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated tasks.md (v${artifact.version}) in ${run.tokensUsed} tokens.`,
  };
}
