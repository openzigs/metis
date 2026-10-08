/**
 * #788 — "Generate constitution.md" (`POST /spec-kit/constitution`).
 *
 * It used to call only `generateConstitution`, which reads `*.md` from an
 * `instructionsDir` the route never passed, so it always wrote an empty
 * skeleton. Now it derives the constitution from the project's own knowledge:
 *
 *   1. Retrieve project RAG on a fixed "what are this project's norms" query
 *      (README, CONTRIBUTING, go.mod / package.json, architecture notes — as
 *      ingested), pinning the rest of the top documents.
 *   2. One model call through `runSpecKitAgent` (budget, safety in/out,
 *      FinOps, audit) asks for a constitution in the format
 *      `/speckit.constitution` validates, every principle citing its source.
 *   3. The draft is completed where the model left out a required metadata
 *      line or section, then persisted through `upsertConstitution`, so it is
 *      versioned exactly like a `/speckit.constitution` write.
 *
 * When there is nothing to ground on — no retrieved knowledge, no configured
 * or online provider, or a reply with no principles — it writes the old
 * skeleton and the result says so (`grounded: false` plus the reason).
 * Generating an ungrounded constitution would be the same no-op, disguised.
 */
import type { AIProvider } from "../../ai/types.js";
import { AIProviderError } from "../../ai/errors.js";
import { generateConstitution } from "../constitution.js";
import {
  extractPrinciples,
  upsertConstitution,
  REQUIRED_SECTIONS,
  type ConstitutionMeta,
} from "../constitution-meta.js";
import {
  buildSpecKitRagContext,
  type SpecKitFusedCodeDeps,
  type SpecKitKnowledgeService,
} from "../rag-context.js";
import { describeGrounding, PINNED_REQUIREMENT_DOCUMENTS } from "../grounding.js";
import { loadProjectContext, runSpecKitAgent } from "./runner.js";

/** What the retrieval asks for: the documents that state a project's norms. */
export const CONSTITUTION_QUERY =
  "Project README and contributing guidelines: purpose, design principles and philosophy, " +
  "coding conventions and style, technology stack and dependencies (go.mod, package.json), " +
  "supported databases and platforms, architecture, testing and code review rules.";

const CONSTITUTION_SYSTEM_PROMPT = [
  "You are a Solution Architect writing a Spec Kit constitution.md for ONE existing project.",
  "",
  "Derive every principle from the project knowledge above (README, contributing guide,",
  "dependency manifests, architecture notes). Each principle names the source it came from in",
  "parentheses. Do not invent norms the project does not state; prefer fewer, real principles.",
  "",
  "Output Markdown ONLY, in this exact shape:",
  "# Project Constitution",
  "",
  "Version: 1.0.0",
  "Ratified: <today>",
  "Last Amended: <today>",
  "",
  "# Core Principles",
  "",
  "## <principle title>",
  "<one or two sentences: the rule, and why, with its source>",
  "(3-8 principles)",
  "",
  "# Governance",
  "<how the constitution is amended; versions follow semver>",
  "",
  "# History",
  "- <today>: Derived from project knowledge.",
].join("\n");

export interface DraftConstitutionInput {
  projectId: string;
  /** Appended verbatim under `# Project-level overrides`. */
  projectOverrides?: string;
  actorId?: string | null;
  sessionId?: string | null;
  /** Lazily builds the project's provider; an `AIProviderError` ⇒ skeleton. */
  resolveProvider: () => Promise<AIProvider>;
  /** Injectable retrieval seams (default: the production wiring). */
  knowledgeService?: SpecKitKnowledgeService;
  fusedCode?: SpecKitFusedCodeDeps;
  /** Date stamped into a missing `Ratified` / `Last Amended` line (tests). */
  today?: Date;
}

export interface DraftConstitutionResult {
  content: string;
  /** True when the body was derived from retrieved project knowledge. */
  grounded: boolean;
  /** The semver metadata; null for the untracked skeleton. */
  meta: ConstitutionMeta | null;
  message: string;
}

export async function draftConstitution(
  input: DraftConstitutionInput,
): Promise<DraftConstitutionResult> {
  const skeleton = async (reason: string): Promise<DraftConstitutionResult> => {
    const content = await generateConstitution({
      projectId: input.projectId,
      ...(input.projectOverrides !== undefined ? { projectOverrides: input.projectOverrides } : {}),
      actorId: input.actorId ?? null,
    });
    return {
      content,
      grounded: false,
      meta: null,
      message:
        `Wrote a constitution skeleton with no principles — ${reason}. ` +
        "Ingest the repository's README and contributing guide and generate again, " +
        "or write the principles with /speckit.constitution.",
    };
  };

  const rag = await buildSpecKitRagContext(input.projectId, CONSTITUTION_QUERY, {
    knowledgeService: input.knowledgeService,
    fusedCode: input.fusedCode,
    expandDocuments: PINNED_REQUIREMENT_DOCUMENTS,
  });
  if (rag.usedChunks === 0 && rag.usedSymbols === 0) {
    return skeleton("no project knowledge was retrieved");
  }

  let provider: AIProvider;
  try {
    provider = await input.resolveProvider();
  } catch (err) {
    if (err instanceof AIProviderError) return skeleton("no AI provider is configured");
    throw err;
  }
  if (provider.offline) return skeleton("no AI provider is configured (offline stub)");

  const run = await runSpecKitAgent({
    command: "constitution",
    project: await loadProjectContext(input.projectId),
    systemPrompt: CONSTITUTION_SYSTEM_PROMPT,
    userPrompt: "Write constitution.md for this project from the project knowledge provided.",
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: { provider },
    ragContext: rag.context,
    ragChunksUsed: rag.usedChunks,
  });

  const today = (input.today ?? new Date()).toISOString().slice(0, 10);
  let body = completeConstitutionDraft(run.content, today);
  if (extractPrinciples(body).length === 0) {
    return skeleton("the model returned no principles");
  }
  const overrides = input.projectOverrides?.trim();
  if (overrides) body = `${body}\n\n# Project-level overrides\n\n${overrides}\n`;

  const result = await upsertConstitution({
    projectId: input.projectId,
    content: body,
    actorId: input.actorId ?? null,
  });
  return {
    content: body,
    grounded: true,
    meta: result.meta,
    message: `Generated constitution.md v${result.toVersion} from project knowledge (${describeGrounding(rag)}). Review the principles before relying on them.`,
  };
}

/**
 * Strip a Markdown fence and add whatever `validateConstitution` requires that
 * the model left out: the three metadata lines (after the title) and the
 * `# Governance` / `# History` sections. Never invents principles.
 */
export function completeConstitutionDraft(raw: string, today: string): string {
  let body = raw
    .trim()
    .replace(/^```[a-z]*\s*\n/i, "")
    .replace(/\n```\s*$/, "")
    .trim();

  const meta: string[] = [];
  if (!/^Version:\s*\d+\.\d+\.\d+/m.test(body)) meta.push("Version: 1.0.0");
  if (!/^Ratified:\s*\d{4}-\d{2}-\d{2}/m.test(body)) meta.push(`Ratified: ${today}`);
  if (!/^Last Amended:\s*\d{4}-\d{2}-\d{2}/m.test(body)) meta.push(`Last Amended: ${today}`);
  if (meta.length > 0) {
    const title = /^# Project Constitution[^\n]*\n/m.exec(body);
    body = title
      ? `${body.slice(0, title.index + title[0].length)}\n${meta.join("\n")}\n${body.slice(title.index + title[0].length)}`
      : `# Project Constitution\n\n${meta.join("\n")}\n\n${body}`;
  }

  const [history, governance] = REQUIRED_SECTIONS;
  if (!history!.test(body))
    body = `${body}\n\n# History\n\n- ${today}: Derived from project knowledge.`;
  if (!governance!.test(body)) {
    body = `${body}\n\n# Governance\n\nAmend through /speckit.constitution; the version follows semver.`;
  }
  return `${body.trim()}\n`;
}
