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
 * skeleton and the result says so (`grounded: false` plus the reason). If the
 * project already has a constitution it is kept unchanged instead.
 * Generating an ungrounded constitution would be the same no-op, disguised.
 */
import type { AIProvider } from "../../ai/types.js";
import { AIProviderError } from "../../ai/errors.js";
import { generateConstitution } from "../constitution.js";
import { getArtifact } from "../artifacts.js";
import {
  getConstitutionMeta,
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
  "Ratified: <date given in the request>",
  "Last Amended: <date given in the request>",
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
  "- <date given in the request>: Derived from project knowledge.",
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
  /** Today's date, for the `Ratified` / `Last Amended` lines (tests). */
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
    // A fallback must never replace a constitution the project already has
    // (tracked, or hand-written): the overwrite is unrecoverable.
    const [existingMeta, existingArtifact] = await Promise.all([
      getConstitutionMeta(input.projectId),
      getArtifact(input.projectId, "constitution.md"),
    ]);
    const existing = existingArtifact?.content ?? "";
    if (existingMeta || (existing.trim() !== "" && !existing.includes("BEGIN auto-managed"))) {
      return {
        content: existing,
        grounded: false,
        meta: existingMeta,
        message: `Kept the existing constitution.md unchanged — ${reason}. Try again once the cause is resolved.`,
      };
    }
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

  // #945 — the model does not know the date: it wrote one (2026-02-01 on
  // 2026-10-08) and, the line being present, the server kept it. Tell it, and
  // overwrite the metadata lines regardless.
  const today = (input.today ?? new Date()).toISOString().slice(0, 10);
  const run = await runSpecKitAgent({
    command: "constitution",
    project: await loadProjectContext(input.projectId),
    systemPrompt: CONSTITUTION_SYSTEM_PROMPT,
    userPrompt: `Write constitution.md for this project from the project knowledge provided. Today is ${today}.`,
    actorId: input.actorId ?? null,
    sessionId: input.sessionId ?? null,
    deps: { provider },
    ragContext: rag.context,
    ragChunksUsed: rag.usedChunks,
  });

  // A re-draft keeps the date the constitution was first ratified.
  const ratifiedAt = (await getConstitutionMeta(input.projectId))?.ratifiedAt;
  let body = completeConstitutionDraft(run.content, today, ratifiedAt?.slice(0, 10) ?? today);
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
 *
 * #945 — `Ratified` and `Last Amended` are always the server's dates
 * (`ratified`, default `today`), never the model's guess.
 */
export function completeConstitutionDraft(
  raw: string,
  today: string,
  ratified: string = today,
): string {
  let body = raw.trim();
  // Prefer the first fenced block (the model may wrap it in prose); else
  // slice from the title so leading prose is dropped.
  const fenced = /```[a-z]*[ \t]*\n([\s\S]*?)\n```/i.exec(body);
  if (fenced) body = fenced[1]!.trim();
  else {
    body = body.replace(/^```[a-z]*\s*\n/i, "").replace(/\n```\s*$/, "");
    const title = body.search(/^# Project Constitution/m);
    if (title > 0) body = body.slice(title);
    body = body.trim();
  }

  const meta: string[] = [];
  if (!/^Version:\s*\d+\.\d+\.\d+/m.test(body)) meta.push("Version: 1.0.0");
  if (/^Ratified:/m.test(body)) body = body.replace(/^Ratified:.*$/m, `Ratified: ${ratified}`);
  else meta.push(`Ratified: ${ratified}`);
  if (/^Last Amended:/m.test(body)) {
    body = body.replace(/^Last Amended:.*$/m, `Last Amended: ${today}`);
  } else meta.push(`Last Amended: ${today}`);
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
