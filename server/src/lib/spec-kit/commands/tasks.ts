/**
 * `/tasks` — runs the PO agent against `.specify/spec.md` + `plan.md` and
 * writes `.specify/tasks.md` (Issue #206).
 */
import { SpecKitArtifactError } from "../artifacts.js";
import {
  commandHint,
  forFeature,
  projectArtifactScope,
  type ArtifactScope,
  type ScopedArtifact,
} from "../artifact-scope.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";
import { findTestsAfterImplementation } from "../grounding.js";

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
  "TEST-FIRST ORDERING — REQUIRED (#20):",
  "  - Tests come before or alongside the code they cover, never after it.",
  "  - Either give a behaviour its own test task that PRECEDES the implementation",
  "    task (which then `depends-on` it), or make the implementation task write",
  "    its own tests and say so in its title (e.g. `… with unit tests`).",
  "  - Never collect test tasks at the end of the checklist.",
  "  - Where plan.md names the existing file a task changes, name it in the task.",
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
  /** #786 — the artifact set to read and write. Defaults to the project's `.specify/`. */
  scope?: ArtifactScope;
}

export interface TasksResult {
  artifact: ScopedArtifact;
  tokensUsed: number;
  message: string;
}

export async function runTasks(input: TasksInput): Promise<TasksResult> {
  const scope = input.scope ?? projectArtifactScope(input.projectId);
  const [spec, plan] = await Promise.all([scope.get("spec.md"), scope.get("plan.md")]);
  if (!spec || spec.content.trim().length === 0) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_TASKS_NEEDS_SPEC",
      `Run ${commandHint(scope, "specify")} before ${commandHint(scope, "tasks")} — no spec.md found`,
    );
  }
  if (!plan || plan.content.trim().length === 0) {
    throw new SpecKitArtifactError(
      409,
      "SPEC_KIT_TASKS_NEEDS_PLAN",
      `Run ${commandHint(scope, "plan")} before ${commandHint(scope, "tasks")} — no plan.md found`,
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

  const artifact = await scope.write("tasks.md", run.content, input.actorId ?? null);

  // #20 — make a test-last ordering visible rather than trusting the prompt.
  const late = findTestsAfterImplementation(run.content);
  const orderNote =
    late.length > 0
      ? ` Test task${late.length === 1 ? "" : "s"} ${late.join(", ")} come${late.length === 1 ? "s" : ""} after the implementation ${late.length === 1 ? "it covers" : "they cover"}.`
      : "";

  return {
    artifact,
    tokensUsed: run.tokensUsed,
    message: `Generated tasks.md (v${artifact.version})${forFeature(scope)} in ${run.tokensUsed} tokens.${orderNote}`,
  };
}
