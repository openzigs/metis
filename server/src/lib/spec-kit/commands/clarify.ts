/**
 * `/clarify [question or answer]` — appends a single Q&A entry to
 * `.specify/clarify.md` (Issue #207).
 *
 * Two modes:
 *   • Empty input → the agent emits ONE clarifying question by reviewing
 *     the current spec/plan/tasks and identifying the highest-impact
 *     ambiguity. Stored as `Q: …` (no answer yet).
 *   • Non-empty input → treated as the operator's answer to the most
 *     recent unanswered question. The runner appends `A: <input>` and
 *     updates the originating artifact when the answer materially
 *     changes a section (in v1.2 this just records the answer; the
 *     follow-up edit is left to the operator).
 */
import type { SpecKitArtifactDto } from "@metis/shared";
import { getArtifact, writeArtifact, SpecKitArtifactError } from "../artifacts.js";
import { runSpecKitAgent, loadProjectContext, type RunDeps } from "./runner.js";

const SYSTEM_PROMPT = [
  "You are a Business Analyst running the Spec Kit /clarify loop.",
  "Identify ONE high-impact ambiguity in the supplied artifacts and emit",
  "exactly one Markdown line in the form: `- **Q:** <question>`.",
  "Do not output anything else.",
].join("\n");

const Q_PREFIX = "- **Q:**";
const A_PREFIX = "- **A:**";

export interface ClarifyInput {
  projectId: string;
  /** Empty string → ask a new question. Non-empty → answer the most recent question. */
  input: string;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
}

export interface ClarifyResult {
  artifact: SpecKitArtifactDto;
  /** When true, the runner asked a new question; otherwise it recorded an answer. */
  questioned: boolean;
  tokensUsed: number;
  message: string;
}

function appendBlock(prev: string, block: string): string {
  const sep = prev.endsWith("\n") || prev.length === 0 ? "" : "\n";
  return `${prev}${sep}${block}\n`;
}

export async function runClarify(input: ClarifyInput): Promise<ClarifyResult> {
  const project = await loadProjectContext(input.projectId);
  const existing = await getArtifact(input.projectId, "clarify.md");
  const prev = existing?.content ?? "";

  const trimmedInput = (input.input ?? "").trim();
  if (trimmedInput.length > 0) {
    // Answer mode — no AI call required.
    if (!prev.includes(Q_PREFIX)) {
      throw new SpecKitArtifactError(
        409,
        "SPEC_KIT_NO_PENDING_QUESTION",
        "No pending question — run /clarify with no arguments first",
      );
    }
    const block = `${A_PREFIX} ${trimmedInput}`;
    const next = appendBlock(prev, block);
    const artifact = await writeArtifact({
      projectId: input.projectId,
      name: "clarify.md",
      content: next,
      actorId: input.actorId ?? null,
    });
    return {
      artifact,
      questioned: false,
      tokensUsed: 0,
      message: `Recorded answer in clarify.md (v${artifact.version}).`,
    };
  }

  // Question mode — invoke the agent.
  const [spec, plan, tasks] = await Promise.all([
    getArtifact(input.projectId, "spec.md"),
    getArtifact(input.projectId, "plan.md"),
    getArtifact(input.projectId, "tasks.md"),
  ]);
  const context = [
    spec ? `spec.md:\n\`\`\`md\n${spec.content}\n\`\`\`` : "",
    plan ? `plan.md:\n\`\`\`md\n${plan.content}\n\`\`\`` : "",
    tasks ? `tasks.md:\n\`\`\`md\n${tasks.content}\n\`\`\`` : "",
    prev ? `Previous Q&A:\n\`\`\`md\n${prev}\n\`\`\`` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const userPrompt = `${context}\n\nIdentify the highest-impact open question.`;

  const run = await runSpecKitAgent({
    command: "clarify",
    project,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: input.deps,
  });

  // Normalise — the agent should already prefix `- **Q:**` but defend
  // against drift.
  const trimmedAgent = run.content.trim();
  const block = trimmedAgent.startsWith(Q_PREFIX)
    ? trimmedAgent
    : `${Q_PREFIX} ${trimmedAgent.replace(/^[-*]\s*\**Q:?\**\s*/i, "")}`;
  const next = appendBlock(prev, block);
  const artifact = await writeArtifact({
    projectId: input.projectId,
    name: "clarify.md",
    content: next,
    actorId: input.actorId ?? null,
  });

  return {
    artifact,
    questioned: true,
    tokensUsed: run.tokensUsed,
    message: `Asked a new question (clarify.md v${artifact.version}, ${run.tokensUsed} tokens).`,
  };
}

export const __TESTING__ = { Q_PREFIX, A_PREFIX };
